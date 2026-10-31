import { ApiError } from '../api/client';
import type { CheckinSyncPageResult, CheckinSyncState } from '../api/types';
import type { CheckinSyncDeps } from '../background/handle-checkin-sync';
import { parseCheckinFeedPage } from '../../../src/shared/untappd/checkin-feed';
import { isBlockPage } from '../../../src/shared/untappd/block';
import { sessionUsername } from '../../../src/shared/untappd/session-user';
import { canonicalCheckinAt } from '../../../src/shared/checkin-sync/checkin-time';
import { checkPage, coverageSpan } from '../../../src/shared/checkin-sync/guards';
import { mergeRange } from '../../../src/shared/checkin-sync/coverage';
import { conclude } from '../../../src/shared/checkin-sync/conclude';
import { currentGeneration, inPageTx, type LocalMeta } from './db';

export const UNTAPPD_HOME = 'https://untappd.com/';

export interface LocalSyncEnv {
  /** GET in the user's untappd.com session (cookies included). */
  fetchText: (url: string) => Promise<string>;
  now?: () => Date;
}

// #924: runCheckinSync's getState/submitPage for local mode — the server route of
// /checkins/sync (§2 of the spec) over IndexedDB, deciding through the same src/shared/ code.
// Refusals throw the ApiError codes the server client maps to, so the walk behaves the same.
export function localSyncDeps(env: LocalSyncEnv): Pick<CheckinSyncDeps, 'getState' | 'submitPage'> {
  const now = () => (env.now ?? (() => new Date()))().toISOString();

  async function getState(): Promise<CheckinSyncState> {
    const username = sessionUsername(await env.fetchText(UNTAPPD_HOME));
    if (username === null) throw new ApiError('no_session');
    const generation = await currentGeneration();
    return inPageTx(async (tx) => {
      let meta = await tx.meta();
      if (meta === null) {
        meta = { username, generation, profileTotal: null, oldestId: null, updatedAt: now() };
        await tx.putMeta(meta);
      } else if (meta.username !== username || meta.generation !== generation) {
        throw new ApiError('account_changed');
      }
      return {
        username,
        linkRevision: meta.generation,
        deepest_max_id: null,
        complete: false,
        serverCount: await tx.count(),
        profileTotal: meta.profileTotal,
      };
    });
  }

  async function submitPage(html: string, maxId: string | null, linkRevision: number): Promise<CheckinSyncPageResult> {
    if (isBlockPage(html)) throw new ApiError('blocked');
    const page = parseCheckinFeedPage(html);
    return inPageTx(async (tx) => {
      const meta = await tx.meta();
      // The page belongs to the database it was fetched for: after Clear, a new database has a new
      // generation, and a late page of the old one is refused before anything is written.
      if (meta === null || meta.generation !== linkRevision) throw new ApiError('account_changed');

      const verdict = checkPage(page, maxId, meta.oldestId);
      if (verdict.kind === 'refuse') {
        throw new ApiError(verdict.code === 'no_session' ? 'no_session' : 'page_rejected', verdict.reason);
      }
      if (verdict.kind === 'empty') {
        return {
          merged: 0,
          alreadyKnown: 0,
          pageSize: 0,
          nextMaxId: null,
          nextCursor: null,
          profileTotal: page.profileTotal ?? meta.profileTotal,
          serverCount: await tx.count(),
          complete: false,
        };
      }

      let merged = 0;
      let alreadyKnown = 0;
      for (const ci of page.checkins) {
        const existed = (await tx.checkin(ci.checkin_id)) !== null;
        // As the server's mergeCheckin: the page's values replace the stored ones, null included —
        // a rating the user removed on Untappd disappears here too.
        await tx.putCheckin({
          checkin_id: ci.checkin_id,
          bid: ci.bid,
          beer_name: ci.beer_name,
          brewery_name: ci.brewery_name,
          user_rating: ci.user_rating,
          checkin_at: canonicalCheckinAt(ci.checkin_at),
        });
        if (existed) alreadyKnown++;
        else merged++;
      }

      const [from, to] = coverageSpan(verdict);
      const ranges = mergeRange(await tx.ranges(), from, to);
      await tx.putRanges(ranges);
      const next: LocalMeta = {
        ...meta,
        profileTotal: page.profileTotal ?? meta.profileTotal,
        oldestId: meta.oldestId === null ? verdict.oldest : Math.min(meta.oldestId, verdict.oldest),
        updatedAt: now(),
      };
      await tx.putMeta(next);

      const serverCount = await tx.count();
      const { nextCursor } = conclude({ count: serverCount, profileTotal: next.profileTotal, ranges, oldest: verdict.oldest });
      return {
        merged,
        alreadyKnown,
        pageSize: page.checkins.length,
        nextMaxId: page.nextMaxId,
        nextCursor,
        profileTotal: page.profileTotal,
        serverCount,
        complete: false,
      };
    });
  }

  return { getState, submitPage };
}
