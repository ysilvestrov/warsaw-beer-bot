import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

// #616. Композиційний корінь невидимий для решти тестів: src/index.ts ніхто не імпортує, тож гілка
// може бути зеленою, поки гідратор не запускається зовсім або запускається під чужим breaker'ом.
// Той самий страж, що й src/jobs/unlock-fixed-orphans.wiring.test.ts.
const src = (): string => readFileSync(path.join(__dirname, '../index.ts'), 'utf8');

test('src/index.ts schedules hydrateRatings on a cron tick, gated by the Algolia breaker', () => {
  const block = src().match(/cron\.schedule\([^)]*\)[\s\S]{0,400}?hydrateRatings\(\{([\s\S]*?)\}\)/);
  expect(block).not.toBeNull();
  expect(block![1]).toMatch(/breaker:\s*algoliaBreaker/);
  expect(block![1]).toMatch(/hydrateByBid:\s*\(bids\)\s*=>\s*algoliaSearch\.hydrateByBid\(bids\)/);
  expect(block![1]).toMatch(/lookupEnabled:\s*env\.UNTAPPD_LOOKUP_ENABLED/);
});

test('the legacy HTML rating job is gone (#616, review I1)', () => {
  expect(src()).not.toMatch(/refreshTapRatings|refresh-tap-ratings/);
  expect(existsSync(path.join(__dirname, 'refresh-tap-ratings.ts'))).toBe(false);
});
