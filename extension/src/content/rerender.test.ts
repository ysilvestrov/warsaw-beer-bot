import { describe, it, expect, vi, beforeEach } from 'vitest';
import { observeReRender } from './rerender';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => { document.body.innerHTML = ''; });

describe('observeReRender', () => {
  it('returns a noop and never fires when the container is absent', async () => {
    const cb = vi.fn();
    const stop = observeReRender(document, '.grid', cb, { debounceMs: 20 });
    document.body.innerHTML = '<div class="x"></div>';
    await tick(40);
    expect(cb).not.toHaveBeenCalled();
    stop();
  });

  it('fires once (debounced) after the container children change', async () => {
    document.body.innerHTML = '<div class="grid"></div>';
    const cb = vi.fn();
    const stop = observeReRender(document, '.grid', cb, { debounceMs: 20 });
    const grid = document.querySelector('.grid')!;
    grid.appendChild(document.createElement('div'));
    grid.appendChild(document.createElement('div'));
    await tick(60);
    expect(cb).toHaveBeenCalledTimes(1);
    stop();
  });

  it('fires after the observed container is replaced', async () => {
    document.body.innerHTML = '<div class="grid"></div>';
    const cb = vi.fn();
    const stop = observeReRender(document, '.grid', cb, { debounceMs: 20 });
    document.body.innerHTML = '<div class="grid"><div></div></div>';
    await tick(60);
    expect(cb).toHaveBeenCalledTimes(1);
    stop();
  });

  it('does not re-trigger from DOM writes made inside the callback', async () => {
    document.body.innerHTML = '<div class="grid"></div>';
    const grid = document.querySelector('.grid')!;
    const cb = vi.fn(() => { grid.appendChild(document.createElement('span')); });
    const stop = observeReRender(document, '.grid', cb, { debounceMs: 20 });
    grid.appendChild(document.createElement('div')); // external trigger
    await tick(80);
    expect(cb).toHaveBeenCalledTimes(1); // the callback's own append did not loop
    stop();
  });

  it('stops firing after the disposer is called', async () => {
    document.body.innerHTML = '<div class="grid"></div>';
    const cb = vi.fn();
    const stop = observeReRender(document, '.grid', cb, { debounceMs: 20 });
    stop();
    document.querySelector('.grid')!.appendChild(document.createElement('div'));
    await tick(40);
    expect(cb).not.toHaveBeenCalled();
  });
});
