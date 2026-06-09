import { describe, it, expect, vi, beforeEach } from 'vitest';
import { observeReRender } from './rerender';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => { document.body.innerHTML = ''; });

describe('observeReRender', () => {
  it('does not fire while hasUnprocessed stays false', async () => {
    const cb = vi.fn();
    const stop = observeReRender(document, () => false, cb, { debounceMs: 20 });
    document.body.innerHTML = '<div class="x"></div>';
    await tick(60);
    expect(cb).not.toHaveBeenCalled();
    stop();
  });

  it('fires once (debounced) when an unprocessed card appears', async () => {
    let unprocessed = false;
    const cb = vi.fn();
    const stop = observeReRender(document, () => unprocessed, cb, { debounceMs: 20 });
    unprocessed = true;
    document.body.appendChild(document.createElement('div'));
    document.body.appendChild(document.createElement('div'));
    await tick(60);
    expect(cb).toHaveBeenCalledTimes(1);
    stop();
  });

  it('fires after the grid is replaced with fresh (unprocessed) nodes', async () => {
    document.body.innerHTML = '<div class="grid"></div>';
    let unprocessed = false;
    const cb = vi.fn();
    const stop = observeReRender(document, () => unprocessed, cb, { debounceMs: 20 });
    unprocessed = true; // fresh nodes after a navigation are unmarked
    document.body.innerHTML = '<div class="grid"><div></div></div>';
    await tick(60);
    expect(cb).toHaveBeenCalledTimes(1);
    stop();
  });

  it('does not re-trigger from DOM writes made inside the callback', async () => {
    // callback writes badge nodes (not cards) -> hasUnprocessed flips false after run
    let unprocessed = true;
    const cb = vi.fn(() => {
      unprocessed = false; // overlay marked the cards seen
      document.body.appendChild(document.createElement('span')); // badge write
    });
    const stop = observeReRender(document, () => unprocessed, cb, { debounceMs: 20 });
    document.body.appendChild(document.createElement('div')); // external trigger
    await tick(100);
    expect(cb).toHaveBeenCalledTimes(1);
    stop();
  });

  it('re-checks after an async run and fires again if work arrived mid-run', async () => {
    const unprocessed = true;
    let resolveRun: (() => void) | undefined;
    const cb = vi.fn(() => {
      // simulate navigation arriving during the async call
      return new Promise<void>((r) => { resolveRun = () => { r(); }; });
    });
    const stop = observeReRender(document, () => unprocessed, cb, { debounceMs: 10 });
    document.body.appendChild(document.createElement('div'));
    await tick(30);                       // run started, awaiting
    document.body.appendChild(document.createElement('div')); // nav during run
    await tick(30);
    resolveRun?.();                       // finish the first run; cards still unprocessed
    await tick(40);
    expect(cb).toHaveBeenCalledTimes(2);  // re-entrancy guard re-ran
    stop();
  });

  it('stops firing after the disposer is called', async () => {
    const cb = vi.fn();
    const stop = observeReRender(document, () => true, cb, { debounceMs: 20 });
    stop();
    document.body.appendChild(document.createElement('div'));
    await tick(40);
    expect(cb).not.toHaveBeenCalled();
  });
});
