export interface ReRenderOptions {
  debounceMs?: number;
}

/**
 * Watch `containerSelector` for child mutations (SPA page swap) and re-run
 * `onReRender`, debounced. The observer is disconnected while the callback runs
 * so the callback's own DOM writes (e.g. badge insertion) cannot retrigger it.
 * Returns a disposer. If the container is absent, returns a no-op disposer.
 */
export function observeReRender(
  root: ParentNode,
  containerSelector: string,
  onReRender: () => unknown,
  opts: ReRenderOptions = {},
): () => void {
  const debounceMs = opts.debounceMs ?? 250;
  let container = root.querySelector(containerSelector);
  if (!container) return () => {};

  const observeTarget =
    (root as Document).body ?? (root instanceof Element ? root : (root as Document).documentElement);
  if (!observeTarget) return () => {};

  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const connect = () => observer.observe(observeTarget, { childList: true, subtree: true });

  const isRelevant = (mutations: MutationRecord[]) => {
    const latest = root.querySelector(containerSelector);
    if (latest !== container || !container?.isConnected) return true;

    return mutations.some((mutation) => {
      const target = mutation.target;
      return target === container || container?.contains(target);
    });
  };

  const run = async () => {
    observer.disconnect();
    try {
      await onReRender();
    } finally {
      container = root.querySelector(containerSelector);
      if (!stopped) connect();
    }
  };

  const schedule = (mutations: MutationRecord[]) => {
    if (!isRelevant(mutations)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void run(), debounceMs);
  };

  const observer = new MutationObserver(schedule);
  connect();

  return () => {
    stopped = true;
    observer.disconnect();
    if (timer) clearTimeout(timer);
  };
}
