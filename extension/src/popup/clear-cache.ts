// #517: "Clear all cache" removes every cached match result across every supported
// shop. It used to do that on one click and report two words. It is now a two-state
// control: the first click counts and arms, the second executes and reports. There is
// deliberately no timer — the armed state lives until the second click or until the
// popup closes (which happens on blur), so the tests carry no timing assumption.

export type ClearState = { armed: false } | { armed: true; count: number };

export const IDLE: ClearState = { armed: false };

export function entries(n: number): string {
  return n === 1 ? '1 entry' : `${n} entries`;
}

export function clearButtonLabel(state: ClearState): string {
  return state.armed ? `Clear cache for ${entries(state.count)}?` : 'Clear all cache';
}

export function clearResultText(removed: number): string {
  return `Cleared ${entries(removed)}.`;
}

export interface ClearDeps {
  /** How many entries are cached right now. */
  count: () => Promise<number>;
  /** Removes them; resolves with how many actually went. */
  clear: () => Promise<number>;
}

export function wireClearButton(
  button: HTMLButtonElement,
  status: HTMLElement,
  deps: ClearDeps,
): void {
  const label = button.querySelector('span');
  let state: ClearState = IDLE;

  const render = (next: ClearState): void => {
    state = next;
    if (label) label.textContent = clearButtonLabel(state);
    button.classList.toggle('btn-danger', state.armed);
  };

  button.addEventListener('click', () => {
    void (async () => {
      if (state.armed) {
        const removed = await deps.clear();
        status.textContent = clearResultText(removed);
        render(IDLE);
        return;
      }
      const n = await deps.count();
      if (n === 0) {
        status.textContent = 'Nothing to clear.';
        return;
      }
      render({ armed: true, count: n });
    })();
  });
}
