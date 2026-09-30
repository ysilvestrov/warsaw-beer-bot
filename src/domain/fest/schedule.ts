// When the server's festival jobs should run (plan 2, task 2). Pure: the cron ticks every minute
// and each job asks here whether its own tick is due.

export const SERVER_POLL_INTERVAL_MS = 10 * 60 * 1000;
export const MENU_INTERVAL_IN_WINDOW_MS = 2 * 60 * 60 * 1000;
export const MENU_INTERVAL_RUN_UP_MS = 6 * 60 * 60 * 1000;

export interface Window {
  start_at: string;
  end_at: string;
}

const due = (now: Date, lastAt: string | null, intervalMs: number): boolean =>
  lastAt === null || now.getTime() - Date.parse(lastAt) >= intervalMs;

/** Page 1 of the festival feed, every 10 min, only inside a polling window. */
export function dueServerPoll(now: Date, inWindow: boolean, lastAt: string | null): boolean {
  return inWindow && due(now, lastAt, SERVER_POLL_INTERVAL_MS);
}

/**
 * The menu: every 6 h in the run-up; inside a polling window at its opening (if not yet read in
 * this window) and then every 2 h; never after the last window has closed.
 * `windows` are the polling windows (session ± margin), in order.
 */
export function dueMenuRefresh(now: Date, windows: Window[], lastAt: string | null): boolean {
  if (windows.length === 0) return false;
  const t = now.getTime();
  if (t > Date.parse(windows[windows.length - 1].end_at)) return false;
  const current = windows.find((w) => t >= Date.parse(w.start_at) && t <= Date.parse(w.end_at));
  if (current) {
    const readThisWindow = lastAt !== null && Date.parse(lastAt) >= Date.parse(current.start_at);
    return !readThisWindow || due(now, lastAt, MENU_INTERVAL_IN_WINDOW_MS);
  }
  return due(now, lastAt, MENU_INTERVAL_RUN_UP_MS);
}
