// Laptop eye for the WFP festival mode (spec 2026-09-29-wfp-team-assistant-design.md §4.3).
//
// A real Chrome with a persistent, logged-in Untappd profile reads the festival venue feeds and
// relays the HTML to the bot (POST /fest/feed, /fest/menu). The server does all parsing and
// decides what the page proves; this script only fetches on the schedule in ./schedule.ts.
//
// Setup (once, on the laptop):
//   cd scripts/fest-eye && npm install
//   FEST_TOKEN=<token from /extension> npx tsx main.ts --login   # log in to Untappd by hand, then Ctrl+C
// Run during the festival:
//   FEST_TOKEN=<token> npx tsx main.ts
// Options: --profile <dir> (default ./profile), FEST_API (default https://beer-api.ysilvestrov-ai.uk).
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { eyeTasks, type EyeConfig, type FeedTask } from './schedule';
import { isBlockPage, isBlockStatus } from '../../src/sources/untappd/block';

const API = (process.env.FEST_API ?? 'https://beer-api.ysilvestrov-ai.uk').replace(/\/$/, '');
const TOKEN = process.env.FEST_TOKEN ?? '';
const UNTAPPD = 'https://untappd.com';
const TICK_MS = 30_000;
const NAV_TIMEOUT_MS = 60_000;
const BLOCK_PAUSE_MS = 10 * 60 * 1000;

const arg = (name: string): string | null => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? '' : null;
};
const profileDir = arg('--profile') || './profile';
const loginOnly = process.argv.includes('--login');

const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), msg, ...extra }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const beep = () => process.stdout.write('\x07');

interface FeedReply { inserted: number; seen: number; dropped: number; mismatched: number; stitched: boolean; nextCursor: string | null }

async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; data: T | { error: string } }> {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: (await res.json().catch(() => ({ error: `http_${res.status}` }))) as T };
}

// The "Show More" XHR, run inside the page so it carries the browser's own Untappd session.
// '' is the end of the feed; 'blocked' a Cloudflare answer; any other failure throws (retried).
async function moreFeed(page: Page, venueId: number, cursor: string): Promise<string | 'blocked'> {
  const url = `${UNTAPPD}/venue/more_feed/${venueId}/${cursor}?filter=&v2=true`;
  const r = await page.evaluate(async (u) => {
    const res = await fetch(u, { headers: { 'X-Requested-With': 'XMLHttpRequest' }, credentials: 'same-origin' });
    return { status: res.status, text: await res.text() };
  }, url);
  // The server's own block rule: 403/429, or a Cloudflare challenge page whatever its status (it
  // comes as 503 too). A plain 503 without the challenge is an outage, retried in a minute.
  if (isBlockStatus(r.status) || isBlockPage(r.text)) return 'blocked';
  if (r.status !== 200) throw new Error(`more_feed answered ${r.status}`);
  return r.text.trim();
}

/** false: the server says the page was a Cloudflare block. Throws on any other failure (retried). */
async function readFeed(page: Page, task: FeedTask): Promise<boolean> {
  await page.goto(UNTAPPD + task.feedPath, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  let reply = await api<FeedReply>('POST', '/fest/feed', {
    venueId: task.venueId, html: await page.content(), cursor: null, fetchedAt: new Date().toISOString(),
  });
  log('feed', { venueId: task.venueId, page: 1, status: reply.status, reply: reply.data });
  if (reply.status === 502) return false;
  if (reply.status !== 200) throw new Error(`POST /fest/feed answered ${reply.status}`);
  // Page further only while the new page does not stitch onto what the server already had.
  // A read counts only when every page it fetched landed: a failed page throws or reports a block.
  for (let n = 2; n <= task.maxPages; n++) {
    const r = reply.data as FeedReply;
    if (r.stitched || r.nextCursor === null) break;
    const fragment = await moreFeed(page, task.venueId, r.nextCursor);
    if (fragment === 'blocked') return false;
    if (fragment === '') break;
    reply = await api<FeedReply>('POST', '/fest/feed', {
      venueId: task.venueId, html: fragment, cursor: r.nextCursor, fetchedAt: new Date().toISOString(),
    });
    log('feed', { venueId: task.venueId, page: n, status: reply.status, reply: reply.data });
    if (reply.status === 502) return false;
    if (reply.status !== 200) throw new Error(`POST /fest/feed answered ${reply.status}`);
  }
  return true;
}

async function readMenu(page: Page, cfg: EyeConfig): Promise<boolean> {
  await page.goto(UNTAPPD + cfg.menuPath, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  const reply = await api('POST', '/fest/menu', { html: await page.content() });
  log('menu', { status: reply.status, reply: reply.data });
  if (reply.status === 502) return false;
  if (reply.status !== 200) throw new Error(`POST /fest/menu answered ${reply.status}`);
  return true;
}

async function main(): Promise<void> {
  if (!TOKEN && !loginOnly) throw new Error('FEST_TOKEN is required (the /extension token of a team member)');
  const ctx: BrowserContext = await chromium.launchPersistentContext(profileDir, { channel: 'chrome', headless: false });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  process.on('SIGINT', () => { void ctx.close().finally(() => process.exit(0)); });

  if (loginOnly) {
    await page.goto(`${UNTAPPD}/login`);
    log('log in to Untappd in the opened window, then press Ctrl+C');
    await new Promise(() => {});
  }

  let cfg: EyeConfig | null = null;
  // Success times drive the cadence; attempt times only rate-limit retries (schedule.ts).
  const state = { configAt: null as number | null, menuAt: null as number | null, feedAt: new Map<number, number>(), attemptAt: new Map<string, number>() };
  let pauseUntil = 0;
  const blocked = (what: string) => {
    pauseUntil = Date.now() + BLOCK_PAUSE_MS;
    beep();
    log(`blocked on ${what}: pausing 10 min — pass the Cloudflare check in the window if one is shown`);
  };

  for (;;) {
    const now = Date.now();
    if (now >= pauseUntil) {
      const tasks = eyeTasks(now, cfg, state);
      try {
        if (tasks.config) {
          state.attemptAt.set('config', now);
          const r = await api<EyeConfig>('GET', '/fest/config');
          log('config', { status: r.status });
          if (r.status === 200) {
            cfg = r.data as EyeConfig;
            state.configAt = now;
          }
        }
        for (const task of tasks.feeds) {
          state.attemptAt.set(`feed:${task.venueId}`, now);
          const ok = await readFeed(page, task);
          if (!ok) {
            blocked(`venue ${task.venueId}`);
            break;
          }
          state.feedAt.set(task.venueId, now);
        }
        if (tasks.menu && cfg && Date.now() >= pauseUntil) {
          state.attemptAt.set('menu', now);
          if (await readMenu(page, cfg)) state.menuAt = now;
          else blocked('menu');
        }
      } catch (e) {
        // A timeout or a dropped Wi-Fi costs one attempt, retried after a minute (measured 2026-09-29).
        log('tick failed', { error: String(e) });
      }
    }
    await sleep(TICK_MS);
  }
}

main().catch((e) => { log('fatal', { error: String(e) }); process.exit(1); });
