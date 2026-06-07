import { describe, it, expect } from 'vitest';
import { waitForSelector } from './grid-ready';

describe('waitForSelector', () => {
  it('resolves true immediately when the selector already exists', async () => {
    document.body.innerHTML = '<div class="card"></div>';
    expect(await waitForSelector(document, '.card', { timeoutMs: 100 })).toBe(true);
  });

  it('resolves true once a matching node is added later', async () => {
    document.body.innerHTML = '<div id="grid"></div>';
    const p = waitForSelector(document, '.card', { timeoutMs: 1000 });
    setTimeout(() => {
      document.getElementById('grid')!.innerHTML = '<div class="card"></div>';
    }, 10);
    expect(await p).toBe(true);
  });

  it('resolves false after the timeout when nothing matches', async () => {
    document.body.innerHTML = '<div id="grid"></div>';
    expect(await waitForSelector(document, '.card', { timeoutMs: 30 })).toBe(false);
  });
});
