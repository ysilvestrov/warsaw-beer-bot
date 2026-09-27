import type { DB } from '../storage/db';
import { listPrunableMedia, markMediaPruned } from '../storage/bug_reports';

interface PruneArgs {
  db: DB;
  now: Date;
  retentionDays?: number;
  unlink(path: string): Promise<void>;
}

export async function pruneBugReportMedia(
  { db, now, retentionDays = 180, unlink }: PruneArgs,
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  let pruned = 0;
  for (const media of listPrunableMedia(db, cutoff)) {
    try {
      await unlink(media.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Bug report media prune failed', { path: media.path, error });
        continue;
      }
    }
    markMediaPruned(db, media.reportId, media.idx, now.toISOString());
    pruned++;
  }
  return pruned;
}
