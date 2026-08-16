import { readFileSync } from 'node:fs';
import path from 'node:path';

// #421. Composition-root wiring is invisible to the rest of the suite: nothing imports
// src/index.ts, so every other test in this change can be green while no row is ever
// unlocked in production. This repo already pins such invariants at the source level after
// a reviewer disabled the whole city gate with all 1848 tests still passing
// (src/bot/commands/city-gate.wiring.test.ts). Same guard, same reason.
test('src/index.ts schedules unlockFixedOrphans on a cron tick', () => {
  const src = readFileSync(path.join(__dirname, '../index.ts'), 'utf8');
  expect(src).toMatch(/cron\.schedule\([^)]*\)[\s\S]{0,300}unlockFixedOrphans\(\{/);
});
