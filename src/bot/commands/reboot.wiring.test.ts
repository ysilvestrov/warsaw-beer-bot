import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// #469 stage 3: the composer and the tick are tested on their own (reboot.test.ts,
// reboot-alert.test.ts); this pins that src/index.ts actually wires them — a dropped line
// would leave the buttons dead and the alert silent with every other test green.
const INDEX = readFileSync(path.resolve(__dirname, '../../index.ts'), 'utf8');

describe('src/index.ts wires #469 stage 3', () => {
  it('registers the reboot composer inside bot.use(...)', () => {
    // Search for the end marker AFTER the start: createRefreshCommand is also named in the imports.
    const start = INDEX.indexOf('bot.use(\n    cityGate,');
    const use = INDEX.slice(start, INDEX.indexOf('createRefreshCommand(', start));
    expect(start > 0).toBe(true);
    expect(use.includes(`createRebootCommand({
      now: () => new Date(),
      currentSince: (now) => currentRebootSince(readHostPatch(now)),
      request: (kind, now) => writeRebootRequest(kind, now),
      snooze: (since, now) => snoozeRebootAlertNow(db, since, now),
      log,
    }),`)).toBe(true);
  });

  it('schedules the guarded tick hourly at :10, only when an admin is configured', () => {
    expect(INDEX.includes("...(env.ADMIN_TELEGRAM_ID ? [cron.schedule('10 * * * *', rebootAlertTick)] : []),")).toBe(true);
  });

  it('sends the alert with the keyboard bound to its since', () => {
    expect(INDEX.includes('sendMessage(env.ADMIN_TELEGRAM_ID!, text, rebootKeyboard(since))')).toBe(true);
  });
});
