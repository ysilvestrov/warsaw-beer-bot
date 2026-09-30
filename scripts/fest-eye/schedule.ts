// What the laptop eye does on a tick (plan 2, task 3). Pure, so the cadence is tested without a
// browser; main.ts only executes the answer.

export interface EyeConfig {
  pollMarginMs: number;
  sessions: { start_at: string; end_at: string }[];
  menuVenueId: number;
  menuPath: string;
  venues: { venueId: number; feedPath: string }[];
}

export interface EyeState {
  /** Times of the last SUCCESSFUL config / menu / feed read; the cadence counts only these. */
  configAt: number | null;
  menuAt: number | null;
  feedAt: ReadonlyMap<number, number>;
  /** Times of the last attempt, keyed 'config' | 'menu' | `feed:<venueId>`; a failure is retried after RETRY_MS. */
  attemptAt: ReadonlyMap<string, number>;
}

export interface FeedTask {
  venueId: number;
  feedPath: string;
  /** More pages allowed when the head page does not stitch: 5 on a venue's first read in a window. */
  maxPages: number;
}

export interface EyeTasks {
  config: boolean;
  menu: boolean;
  feeds: FeedTask[];
  inWindow: boolean;
}

export const CONFIG_EVERY_MS = 60 * 60 * 1000;
export const FEST_VENUE_EVERY_MS = 3 * 60 * 1000;
export const OTHER_VENUE_EVERY_MS = 6 * 60 * 1000;
export const MENU_EVERY_MS = 2 * 60 * 60 * 1000;
/** A failed task is retried, but not on every 30-second tick. */
export const RETRY_MS = 60 * 1000;

const due = (now: number, at: number | null | undefined, every: number): boolean =>
  at === null || at === undefined || now - at >= every;

export function eyeTasks(now: number, cfg: EyeConfig | null, state: EyeState): EyeTasks {
  const resting = (key: string) => {
    const at = state.attemptAt.get(key);
    return at !== undefined && now - at < RETRY_MS;
  };
  if (cfg === null) return { config: !resting('config'), menu: false, feeds: [], inWindow: false };
  const window = cfg.sessions
    .map((s) => ({ start: Date.parse(s.start_at) - cfg.pollMarginMs, end: Date.parse(s.end_at) + cfg.pollMarginMs }))
    .find((w) => now >= w.start && now <= w.end);
  const config = due(now, state.configAt, CONFIG_EVERY_MS) && !resting('config');
  if (!window) return { config, menu: false, feeds: [], inWindow: false };

  // The first read in a window must reach back past the doors opening, so it may page further.
  const readInWindow = (at: number | null | undefined) => at !== null && at !== undefined && at >= window.start;
  const feeds = cfg.venues.flatMap((v): FeedTask[] => {
    const at = state.feedAt.get(v.venueId);
    const every = v.venueId === cfg.menuVenueId ? FEST_VENUE_EVERY_MS : OTHER_VENUE_EVERY_MS;
    if (readInWindow(at) && !due(now, at, every)) return [];
    if (resting(`feed:${v.venueId}`)) return [];
    return [{ venueId: v.venueId, feedPath: v.feedPath, maxPages: readInWindow(at) ? 3 : 5 }];
  });
  const menu = (!readInWindow(state.menuAt) || due(now, state.menuAt, MENU_EVERY_MS)) && !resting('menu');
  return { config, menu, feeds, inWindow: true };
}
