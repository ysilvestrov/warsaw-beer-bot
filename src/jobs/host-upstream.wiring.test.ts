import { readFileSync } from 'node:fs';
import path from 'node:path';

// #469: nothing imports src/index.ts, so the composition-root wiring is pinned at the source
// level, like src/jobs/unlock-fixed-orphans.wiring.test.ts.
const src = readFileSync(path.join(__dirname, '../index.ts'), 'utf8');

test('src/index.ts schedules hostUpstream on an hourly cron tick', () => {
  expect(src).toMatch(/cron\.schedule\('50 \* \* \* \*'[\s\S]{0,200}hostUpstream\(\{ db, log \}\)/);
});

// Cross-review (codex @ bb0b2b1): the startup digest used to be built before the startup fetch,
// so a first deploy inside the morning window sent "ще не завантажено" for every upstream line.
test('the startup digest waits for the startup upstream fetch, whether it succeeds or not', () => {
  expect(src).toMatch(/hostUpstream\(\{ db, log \}\)\s*\.catch\([^)]*\)[^;]*\)\s*\.finally\(\(\) =>\s*dailyStatus\(/);
});
