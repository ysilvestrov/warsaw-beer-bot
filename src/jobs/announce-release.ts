import type pino from 'pino';
import type { DB } from '../storage/db';
import type { Translator } from '../i18n/types';
import { createTranslator } from '../i18n';
import { getJobState, setJobState } from '../storage/job_state';
import { warsawDateAndHour } from '../domain/warsaw-time';
import { announceRecipients } from '../storage/announce';
import { compareVersions } from '../sources/cws-version';
import { escapeHtml } from '../bot/commands/html';

export const ANNOUNCED_VERSION_KEY = 'extension_announced_version';

// Rendered from extension/CHANGELOG.md by scripts/render-docs.ts. The bot links to it
// rather than quoting notes: the changelog file is not shipped to production at all
// (deploy/rsync-filter carries neither extension/** nor docs/**), so quoting would mean
// either a fragile HTML scraper or widening what "production" means (#542).
export const CHANGELOG_URL = 'https://ysilvestrov.github.io/warsaw-beer-bot/changelog/';

export const SEND_WINDOW_START_HOUR = 9;
export const SEND_WINDOW_END_HOUR = 22;

/**
 * Whether now falls in the Warsaw [09:00, 22:00) civil window. A store review finishes
 * when it finishes; without this an announcement could land at 03:00.
 */
export function inSendWindow(now: Date): boolean {
  const { hour } = warsawDateAndHour(now);
  return hour >= SEND_WINDOW_START_HOUR && hour < SEND_WINDOW_END_HOUR;
}

/** HTML body of one announcement. Every locale string is escaped here, in the builder. */
export function buildAnnouncement(t: Translator, version: string, url: string): string {
  return [
    escapeHtml(t('announce.released', { version })),
    escapeHtml(t('announce.changelog', { url })),
    escapeHtml(t('announce.opt_out_hint')),
  ].join('\n\n');
}

export type SendFailure = 'blocked' | 'rate_limited' | 'other';

interface TelegramErrorish {
  code?: unknown;
  parameters?: { retry_after?: unknown };
  response?: { error_code?: unknown; parameters?: { retry_after?: unknown } };
}

/**
 * Telegraf puts the API error code on either `err.code` or `err.response.error_code`,
 * and `retry_after` on either `err.parameters` or `err.response.parameters`. Nothing in
 * this repo had ever read that shape — the retired broadcast swallowed every error with
 * a bare catch — so both forms are read and `instanceof` is avoided entirely: we have
 * been burned before by an SDK whose error class was not what we expected while its
 * fields were exactly where documented. An unrecognized shape is 'other', never a
 * silent success.
 */
export function classifySendFailure(err: unknown): {
  kind: SendFailure;
  retryAfterSec: number | null;
} {
  const e = (err ?? {}) as TelegramErrorish;
  const code =
    typeof e.code === 'number' ? e.code
    : typeof e.response?.error_code === 'number' ? e.response.error_code
    : null;
  const retryAfter =
    typeof e.parameters?.retry_after === 'number' ? e.parameters.retry_after
    : typeof e.response?.parameters?.retry_after === 'number' ? e.response.parameters.retry_after
    : null;
  if (code === 403) return { kind: 'blocked', retryAfterSec: null };
  if (code === 429) return { kind: 'rate_limited', retryAfterSec: retryAfter };
  return { kind: 'other', retryAfterSec: null };
}

export interface AnnounceResult {
  outcome: 'outside_window' | 'unavailable' | 'seeded' | 'unchanged' | 'rollback' | 'announced';
  version: string | null;
  sent: number;
  failed: Record<SendFailure, number>;
}

export interface AnnounceDeps {
  db: DB;
  log: pino.Logger;
  now?: () => Date;
  /** Resolves to the live published version, or null when it cannot be read. */
  fetchVersion: () => Promise<string | null>;
  /** Delivers one message; throws on failure — the job classifies. */
  send: (telegramId: number, html: string) => Promise<void>;
  notifyAdmin?: (msg: string) => void;
  gapMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const noFailures = (): Record<SendFailure, number> => ({ blocked: 0, rate_limited: 0, other: 0 });

/**
 * Announces a newly published extension version to opted-in token holders, at most once
 * per version (#379).
 *
 * Runs on a frequent UTC tick; the Warsaw window check and the job_state marker live
 * here rather than in the cron expression because node-cron's timezone pin silently
 * skipped a run on this host on 2026-06-21.
 */
export async function announceRelease(deps: AnnounceDeps): Promise<AnnounceResult> {
  const { db, log } = deps;
  const now = (deps.now ?? (() => new Date()))();

  if (!inSendWindow(now)) {
    log.debug('announce-release: outside the Warsaw send window');
    return { outcome: 'outside_window', version: null, sent: 0, failed: noFailures() };
  }

  let seen: string | null = null;
  try {
    seen = await deps.fetchVersion();
  } catch (e) {
    log.warn({ err: e }, 'announce-release: update check failed');
  }
  if (!seen) {
    // Deliberately NOT treated as "unchanged": a shape we cannot read must never be
    // mistaken for evidence that nothing was published.
    log.warn('announce-release: could not read the published version');
    return { outcome: 'unavailable', version: null, sent: 0, failed: noFailures() };
  }

  const stored = getJobState(db, ANNOUNCED_VERSION_KEY);
  if (stored === null) {
    setJobState(db, ANNOUNCED_VERSION_KEY, seen);
    log.info({ version: seen }, 'announce-release: seeded marker, nothing announced');
    return { outcome: 'seeded', version: seen, sent: 0, failed: noFailures() };
  }

  const cmp = compareVersions(seen, stored);
  if (cmp === 0) {
    return { outcome: 'unchanged', version: seen, sent: 0, failed: noFailures() };
  }
  if (cmp < 0) {
    setJobState(db, ANNOUNCED_VERSION_KEY, seen);
    log.warn({ seen, stored }, 'announce-release: published version went backwards');
    return { outcome: 'rollback', version: seen, sent: 0, failed: noFailures() };
  }

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const gapMs = deps.gapMs ?? 50;
  const failed = noFailures();
  let sent = 0;

  for (const recipient of announceRecipients(db)) {
    const html = buildAnnouncement(createTranslator(recipient.language ?? 'en'), seen, CHANGELOG_URL);
    let delivered = false;
    // Two attempts at most, and the second only for a rate limit that told us how long
    // to wait. A 429 without retry_after gets no guessed delay.
    for (let attempt = 0; attempt < 2 && !delivered; attempt++) {
      try {
        await deps.send(recipient.telegramId, html);
        delivered = true;
      } catch (e) {
        const { kind, retryAfterSec } = classifySendFailure(e);
        if (attempt === 0 && kind === 'rate_limited' && retryAfterSec !== null) {
          await sleep(retryAfterSec * 1000);
          continue;
        }
        log.warn({ err: e, telegramId: recipient.telegramId, kind }, 'announce-release: delivery failed');
        failed[kind]++;
        // Give up on this recipient. Without the break, a 403 would be retried and
        // counted twice, because the loop's own guard only stops on success.
        break;
      }
    }
    if (delivered) sent++;
    await sleep(gapMs); // ~20 msg/s, the throttle #283 left as an obligation
  }

  // Only now. If the process dies mid-loop the marker still holds the old version and
  // the next tick retries; writing first would lose the announcement permanently.
  setJobState(db, ANNOUNCED_VERSION_KEY, seen);
  const total = failed.blocked + failed.rate_limited + failed.other;
  log.info({ version: seen, sent, failed }, 'announce-release sent');
  deps.notifyAdmin?.(
    `📣 Анонс ${seen}: sent=${sent} failed=${total} ` +
      `(blocked=${failed.blocked}, rate_limited=${failed.rate_limited}, other=${failed.other})`,
  );
  return { outcome: 'announced', version: seen, sent, failed };
}
