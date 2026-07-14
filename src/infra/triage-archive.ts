import type pino from 'pino';
import { promises as fsp } from 'fs';
import { join } from 'path';

export interface TriageArchive {
  /** Best-effort: logs a warn and returns on any fs error; never throws. */
  write(dateKey: string, payload: unknown): Promise<void>;
}

type ArchiveFs = Pick<typeof fsp, 'mkdir' | 'writeFile' | 'readdir' | 'rm'>;

// dir empty/unset ⇒ null (archive disabled). One file per run/day, so a same-day
// retry-run overwrites its own file. Rotation keeps the newest `keep` by name —
// `YYYY-MM-DD.json` sorts lexicographically = chronologically.
export function createTriageArchive(
  cfg: { dir: string; keep?: number },
  log: pino.Logger,
  fs: ArchiveFs = fsp,
): TriageArchive | null {
  const dir = cfg.dir.trim();
  if (!dir) return null;
  const keep = cfg.keep ?? 30;
  return {
    async write(dateKey, payload) {
      try {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(join(dir, `${dateKey}.json`), JSON.stringify(payload, null, 2), 'utf8');
        const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).sort();
        for (const f of files.slice(0, Math.max(0, files.length - keep))) {
          await fs.rm(join(dir, f));
        }
      } catch (err) {
        log.warn({ err }, 'triage-archive: write failed');
      }
    },
  };
}
