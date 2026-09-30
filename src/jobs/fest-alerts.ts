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
  /** Tests shorten it; production uses ALERT_SEND_TIMEOUT_MS. */
  sendTimeoutMs?: number;
}

/**
 * A send that has not settled by then counts as failed and is retried on the next tick. If it
 * was delivered after all, the group sees the alert twice — rarer and cheaper than a stalled job.
 */
export const ALERT_SEND_TIMEOUT_MS = 20 * 1000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
    // Teams in turn, each send bounded by ALERT_SEND_TIMEOUT_MS, so a hung send delays the teams
    // after it by at most that much; a failure of one team is logged and the loop moves on. Ticks
    // never overlap (the cron's in-flight guard). Sized for a festival's handful of teams — one
    // message per team per tick, far below Telegram's bot-wide rate — so there is no pacing.
    for (const team of teamsOfFest(deps.db, fest.id)) {
      try {
        if (await alertTeam(deps, { festId: fest.id, sessionNo: session.session_no, teamId: team.id, chatId: team.chat_id, venueIds, since }, now)) sent++;
      } catch (e) {
        deps.log.error({ err: e, teamId: team.id }, 'fest alert failed for a team');
      }
    }
  }
  return sent;
}

async function alertTeam(
  deps: FestAlertDeps,
  p: { festId: number; sessionNo: number; teamId: number; chatId: number; venueIds: number[]; since: string },
  now: Date,
): Promise<boolean> {
  const teamMembers = members(deps.db, p.teamId);
  if (teamMembers.length === 0) return false;
  const view = buildFestView(deps.db, { festId: p.festId, teamId: p.teamId, now });
  const onTap: OnTapTarget[] = view.targets.flatMap((target) => {
    const bid = view.bidByBeer.get(target.beerId);
    if (bid === undefined || view.statusByBeer.get(target.beerId)?.kind !== 'on_tap') return [];
    const first = firstCheckinSince(deps.db, p.venueIds, bid, p.since);
    return first ? [{ beerId: target.beerId, firstAt: first.checkin_at, firstCheckinId: first.checkin_id }] : [];
  });
  const plan = planAlerts({ onTap, sent: sentFor(deps.db, p.teamId, p.sessionNo), now });
  const t = createTranslator(getUserLanguage(deps.db, teamMembers[0].telegram_id) ?? 'uk');
  const message = formatAlert(t, view, plan);
  if (message === null) return false;
  try {
    await withTimeout(deps.send(p.chatId, message.html), deps.sendTimeoutMs ?? ALERT_SEND_TIMEOUT_MS);
  } catch (e) {
    deps.log.warn({ err: e, teamId: p.teamId }, 'fest alert not delivered; retrying next tick');
    return false;
  }
  // Only the beers that made it into the message: the rest are announced on the next tick.
  const included = new Set(message.beerIds);
  recordSent(deps.db, [...plan.fresh, ...plan.pouring].filter((a) => included.has(a.beerId)).map((a) => ({
    teamId: p.teamId, sessionNo: p.sessionNo, beerId: a.beerId, checkinId: a.firstCheckinId,
  })), now.toISOString());
  return true;
}
