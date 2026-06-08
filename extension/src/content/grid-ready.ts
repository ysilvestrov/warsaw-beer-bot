export interface WaitOptions {
  timeoutMs?: number;
}

export function waitForSelector(
  root: ParentNode,
  selector: string,
  opts: WaitOptions = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  if (root.querySelector(selector)) return Promise.resolve(true);

  const observeTarget =
    (root as Document).body ?? (root instanceof Element ? root : (root as Document).documentElement);

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timer);
      resolve(value);
    };
    const observer = new MutationObserver(() => {
      if (root.querySelector(selector)) finish(true);
    });
    if (observeTarget) observer.observe(observeTarget, { childList: true, subtree: true });
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}
