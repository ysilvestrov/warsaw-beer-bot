import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * #798 — merge-deploy must keep ticking after a slow boot.
 *
 * Probed 2026-10-07 on systemd 255 with three transient timers: a stamp from an earlier trigger
 * (Persistent=true writes one) plus an OnBootSec that had already passed when the timer
 * activated gave NextElapse=infinity and 0 runs; OnActiveSec with the same stamp fired after
 * its delay. After the 2026-10-06 reboot the timer activated at boot+536 s and never fired.
 */
const TIMER = readFileSync(resolve(__dirname, '../../deploy/wbb-autodeploy.timer'), 'utf8');

/** The [Timer] section's directives, comments and blank lines dropped. */
const directives = TIMER.split('[Timer]')[1]
  .split('\n[')[0]
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l !== '' && !l.startsWith('#'));

describe('wbb-autodeploy.timer', () => {
  it('arms its first tick from its own activation, never from boot', () => {
    expect(directives).toEqual([
      'OnActiveSec=5min',
      'OnUnitActiveSec=5min',
      'RandomizedDelaySec=60',
      'Persistent=true',
    ]);
  });
});
