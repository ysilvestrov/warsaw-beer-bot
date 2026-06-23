import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import { getProfile, getUserCity, getUserLanguage } from '../../storage/user_profiles';
import { getFilters } from '../../storage/user_filters';
import { countCheckins, drunkBeerIds, latestCheckinAt } from '../../storage/checkins';
import { getSyncState } from '../../storage/checkin_sync_state';
import { buildStatusMessage, type StatusView } from './status-build';

export const statusCommand = new Composer<BotContext>();

statusCommand.command('status', async (ctx) => {
  const db = ctx.deps.db;
  const id = ctx.from.id;
  const profile = getProfile(db, id);
  const sync = getSyncState(db, id);

  const view: StatusView = {
    city: getUserCity(db, id),
    language: getUserLanguage(db, id),
    filters: getFilters(db, id),
    linked: !!profile?.untappd_username,
    username: profile?.untappd_username ?? null,
    synced: countCheckins(db, id),
    profileTotal: sync.profile_total,
    complete: sync.complete,
    distinctBeers: drunkBeerIds(db, id).size,
    lastCheckinAt: latestCheckinAt(db, id),
  };

  await ctx.replyWithHTML(buildStatusMessage(ctx.t, view));
});
