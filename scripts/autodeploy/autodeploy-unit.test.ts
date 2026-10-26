import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The merge-deploy unit and timer (plan docs/superpowers/plans/2026-10/2026-10-22-wbb-image-transition-v-core.md,
 * "Рішення" п.5): the unit never cuts the image controller's worst tick short, and only its failures
 * (3 incident / STATE CORRUPT, 4 state write) are systemd failures.
 */
const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8');

/** A section's directives, comments and blank lines dropped. */
function directives(unit: string, section: string): string[] {
  return unit.split(`[${section}]`)[1]
    .split('\n[')[0]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

describe('wbb-autodeploy.service', () => {
  const service = directives(read('deploy/wbb-autodeploy.service'), 'Service');

  it('runs the installed controller as the operator, once per trigger', () => {
    expect(service.filter((d) => /^(Type|User|Environment|ExecStart)=/.test(d))).toEqual([
      'Type=oneshot',
      'User=ysi',
      'Environment=HOME=/home/ysi',
      'ExecStart=/usr/local/bin/wbb-autodeploy',
    ]);
  });

  it('gives a tick 125 min, exactly the controller\'s TICK_BUDGET_S', () => {
    const timeout = service.filter((d) => d.startsWith('TimeoutStartSec='));
    expect(timeout).toEqual(['TimeoutStartSec=125min']);
    const minutes = Number(/^TimeoutStartSec=(\d+)min$/.exec(timeout[0])?.[1]);
    const budget = Number(/^TICK_BUDGET_S=(\d+)$/m.exec(read('deploy/autodeploy.sh'))?.[1]);
    expect(minutes * 60).toBe(budget);
  });

  it('treats 0, 1 (refused) and 2 (rolled back) as success — 3 and 4 stay failures', () => {
    expect(service.filter((d) => d.startsWith('SuccessExitStatus='))).toEqual(['SuccessExitStatus=0 1 2']);
  });
});

/**
 * #798 — merge-deploy must keep ticking after a slow boot.
 *
 * Probed 2026-10-07 on systemd 255 with three transient timers: a stamp from an earlier trigger
 * (Persistent=true writes one) plus an OnBootSec that had already passed when the timer
 * activated gave NextElapse=infinity and 0 runs; OnActiveSec with the same stamp fired after
 * its delay. After the 2026-10-06 reboot the timer activated at boot+536 s and never fired.
 */
describe('wbb-autodeploy.timer', () => {
  it('arms its first tick from its own activation, never from boot', () => {
    expect(directives(read('deploy/wbb-autodeploy.timer'), 'Timer')).toEqual([
      'OnActiveSec=5min',
      'OnUnitActiveSec=5min',
      'RandomizedDelaySec=60',
      'Persistent=true',
    ]);
  });
});
