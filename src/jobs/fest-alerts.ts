import type pino from 'pino';
import type { DB } from '../storage/db';
import { activeFests, festVenues, POLL_MARGIN_MS } from '../storage/fests';
import { members, teamsOfFest } from '../storage/fest_teams';
import { firstCheckinSince } from '../storage/venue_checkins';
import { recordSent, sentFor } from '../storage/fest_alerts';
import { getUserLanguage } from '../storage/user_profiles';
import { planAlerts, type OnTapTarget } from '../domain/fest/alerts';
import { createTranslator } from '../i18n';
import { formatAlert } from '../bot/commands/fest-format';
import { buildFestView } from './fest-view';

export interface FestAlertDeps {
  db: DB;
  log: pino.Logger;
  /** Sends HTML to a team's group chat; rejects when Telegram does not take it. */
  send: (chatId: number, html: string) => Promise<void>;
}

// Group alerts (spec §6.5), one tick per minute. A beer is announced once per team and session;
// the rows are written only after Telegram took the message, so a failed send is retried on the
// next tick instead of being lost. The job needs no cookie: the laptop eye may be the only source.
export async function runFestAlerts(deps: FestAlertDeps, now: Date): Promise<number> {
  let sent = 0;
  for (const { fest, session } of activeFests(deps.db, now)) {
    const venueIds = festVenues(deps.db, fest.id).map((v) => v.venue_id);
    // Check-ins from the polling window count: a stand may pour before the doors open.
    const since = new Date(Date.parse(session.start_at) - POLL_MARGIN_MS).toISOString();
    for (const team of teamsOfFest(deps.db, fest.id)) {
      const teamMembers = members(deps.db, team.id);
      if (teamMembers.length === 0) continue;
      const view = buildFestView(deps.db, { festId: fest.id, teamId: team.id, now });
      const onTap: OnTapTarget[] = view.targets.flatMap((target) => {
        const bid = view.bidByBeer.get(target.beerId);
        if (bid === undefined || view.statusByBeer.get(target.beerId)?.kind !== 'on_tap') return [];
        const first = firstCheckinSince(deps.db, venueIds, bid, since);
        return first ? [{ beerId: target.beerId, firstAt: first.checkin_at, firstCheckinId: first.checkin_id }] : [];
      });
      const plan = planAlerts({ onTap, sent: sentFor(deps.db, team.id, session.session_no), now });
      const t = createTranslator(getUserLanguage(deps.db, teamMembers[0].telegram_id) ?? 'uk');
      const html = formatAlert(t, view, plan);
      if (html === null) continue;
      try {
        await deps.send(team.chat_id, html);
      } catch (e) {
        deps.log.warn({ err: e, teamId: team.id }, 'fest alert not delivered; retrying next tick');
        continue;
      }
      recordSent(deps.db, [...plan.fresh, ...plan.pouring].map((a) => ({
        teamId: team.id, sessionNo: session.session_no, beerId: a.beerId, checkinId: a.firstCheckinId,
      })), now.toISOString());
      sent++;
    }
  }
  return sent;
}
