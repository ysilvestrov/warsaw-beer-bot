import { describe, expect, it, vi } from 'vitest';
import { clearButtonLabel, clearResultText, entries, IDLE, wireClearButton } from './clear-cache';

function fixture() {
  const button = document.createElement('button');
  button.className = 'btn btn-ghost';
  const label = document.createElement('span');
  label.textContent = 'Clear all cache';
  button.append(label);
  const status = document.createElement('p');
  return { button, status, label };
}

describe('copy', () => {
  it('uses the singular for one entry', () => {
    expect(entries(1)).toBe('1 entry');
    expect(entries(3)).toBe('3 entries');
  });
  it('labels the idle and armed states', () => {
    expect(clearButtonLabel(IDLE)).toBe('Clear all cache');
    expect(clearButtonLabel({ armed: true, count: 412 })).toBe('Clear cache for 412 entries?');
    expect(clearButtonLabel({ armed: true, count: 1 })).toBe('Clear cache for 1 entry?');
  });
  it('reports what was removed', () => {
    expect(clearResultText(412)).toBe('Cleared 412 entries.');
    expect(clearResultText(1)).toBe('Cleared 1 entry.');
  });
});

describe('wireClearButton', () => {
  it('arms with the count on the first click and clears nothing yet', async () => {
    const { button, status, label } = fixture();
    const clear = vi.fn(async () => 3);
    wireClearButton(button, status, { count: async () => 3, clear });

    button.click();
    await vi.waitFor(() => expect(label.textContent).toBe('Clear cache for 3 entries?'));
    expect(button.classList.contains('btn-danger')).toBe(true);
    expect(clear).not.toHaveBeenCalled();
    expect(status.textContent).toBe('');
  });

  it('clears on the second click and returns to idle', async () => {
    const { button, status, label } = fixture();
    const clear = vi.fn(async () => 3);
    const count = vi.fn(async () => 3);
    wireClearButton(button, status, { count, clear });

    button.click();
    await vi.waitFor(() => expect(label.textContent).toBe('Clear cache for 3 entries?'));
    button.click();
    await vi.waitFor(() => expect(status.textContent).toBe('Cleared 3 entries.'));
    expect(label.textContent).toBe('Clear all cache');
    expect(button.classList.contains('btn-danger')).toBe(false);
    expect(count).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('never arms on an empty cache', async () => {
    const { button, status, label } = fixture();
    const clear = vi.fn(async () => 0);
    wireClearButton(button, status, { count: async () => 0, clear });

    button.click();
    await vi.waitFor(() => expect(status.textContent).toBe('Nothing to clear.'));
    expect(label.textContent).toBe('Clear all cache');
    expect(button.classList.contains('btn-danger')).toBe(false);
    expect(clear).not.toHaveBeenCalled();
  });

  it('reports what was actually removed, not what was counted', async () => {
    const { button, status } = fixture();
    wireClearButton(button, status, { count: async () => 3, clear: async () => 2 });

    button.click();
    await vi.waitFor(() => expect(button.classList.contains('btn-danger')).toBe(true));
    button.click();
    await vi.waitFor(() => expect(status.textContent).toBe('Cleared 2 entries.'));
  });

  it('ignores rapid double-click from idle state and calls count once', async () => {
    const { button, label, status } = fixture();
    const count = vi.fn(async () => 5);
    wireClearButton(button, status, { count, clear: vi.fn() });

    button.click();
    button.click(); // second click before first count() settles
    await vi.waitFor(() => expect(label.textContent).toBe('Clear cache for 5 entries?'));
    expect(count).toHaveBeenCalledTimes(1);
  });

  it('ignores rapid double-click from armed state and calls clear once', async () => {
    const { button, status } = fixture();
    const clear = vi.fn(async () => 5);
    const count = vi.fn(async () => 5);
    wireClearButton(button, status, { count, clear });

    button.click();
    await vi.waitFor(() => expect(button.classList.contains('btn-danger')).toBe(true));

    clear.mockClear(); // reset to measure second sequence
    button.click();
    button.click(); // second click before first clear() settles
    await vi.waitFor(() => expect(status.textContent).toBe('Cleared 5 entries.'));
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
