import { readFileSync } from 'node:fs';
import path from 'node:path';

// #379. Composition-root wiring is invisible to the rest of the suite: nothing imports
// src/index.ts, so every other test in this change can be green while production never
// announces a release. Same guard, same reason, as
// src/jobs/unlock-fixed-orphans.wiring.test.ts.
const src = (): string => readFileSync(path.join(__dirname, '../index.ts'), 'utf8');

test('src/index.ts schedules announceRelease on a cron tick', () => {
  expect(src()).toMatch(/cron\.schedule\([^)]*\)[\s\S]{0,400}announceRelease\(\{/);
});

test('the announce cron runs hourly, not on a timezone-pinned schedule', () => {
  expect(src()).toMatch(/cron\.schedule\('40 \* \* \* \*'/);
});

test('src/index.ts mounts the /announce command composer', () => {
  expect(src()).toMatch(/bot\.use\([\s\S]{0,600}announceCommand,/);
});
