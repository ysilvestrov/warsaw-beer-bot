export interface ReRenderOptions {
  debounceMs?: number;
}

/**
 * Re-run `onReRender` whenever the shop renders fresh, unprocessed cards
 * (navigation, SPA re-mount, infinite scroll). Watches `document.body` for child
 * mutations, debounced, and gates each run on `hasUnprocessed()`.
 *
 * No disconnect during the callback: the overlay's own badge writes are not
 * cards and do not flip `hasUnprocessed`, so they never self-trigger; navigation
 * arriving mid-run is caught by the re-entrancy guard. Returns a disposer.
 */
export function observeReRender(
  root: ParentNode,
  hasUnprocessed: () => boolean,
  onReRender: () => unknown,
  opts: ReRenderOptions = {},
): () => void {
  const debounceMs = opts.debounceMs ?? 250;
  const target =
    (root as Document).body ?? (root instanceof Element ? root : (root as Document).documentElement);
  if (!target) return () => {};

  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let running = false;
  let pending = false;

  const run = async () => {
    running = true;
    try {
      await onReRender();
    } finally {
      running = false;
      if (!stopped && pending) {
        pending = false;
        check();
      }
    }
  };

  const check = () => {
    if (stopped) return;
    if (running) { pending = true; return; }
    if (hasUnprocessed()) void run();
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(check, debounceMs);
  };

  const observer = new MutationObserver(schedule);
  observer.observe(target, { childList: true, subtree: true });

  return () => {
    stopped = true;
    observer.disconnect();
    if (timer) clearTimeout(timer);
  };
}
