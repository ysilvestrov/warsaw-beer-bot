import { readFileSync } from 'node:fs';
import path from 'node:path';

// #379. Composition-root wiring is invisible to the rest of the suite: nothing imports
// src/index.ts, so every other test in this change can be green while production never
// announces a release. Same guard, same reason, as
// src/jobs/unlock-fixed-orphans.wiring.test.ts.
//
// The schedule and the job call are checked in ONE match, not two: two separate
// regexes (one for the literal '40 * * * *' appearing anywhere, one for any
// cron.schedule(...) followed by announceRelease({) are jointly defeatable — retune
// the announce block to a different minute and drop an unrelated
// cron.schedule('40 * * * *', ...) elsewhere in the file, and both pass while the
// job no longer runs hourly at minute 40. Anchoring the literal directly onto
// announceRelease({ closes that gap.
//
// The callback is anchored immediately after the schedule string too — a bare
// `[\s\S]{0,400}?` gap between the literal and announceRelease({ would tolerate a
// `{ timezone: ... }` second argument slipped in between (node-cron's timezone
// pin is exactly the thing this schedule must NOT carry, per the job's own
// design note in src/index.ts). Requiring `, () => {` right after the quote
// closes that gap: any second argument breaks the match.
const src = (): string => readFileSync(path.join(__dirname, '../index.ts'), 'utf8');

test('src/index.ts schedules announceRelease hourly at minute 40, not on a timezone-pinned schedule', () => {
  // Optional whitespace between `schedule(` and the literal tolerates a Prettier-style
  // multi-line reformat of a semantically correct call; the rest of the anchor —
  // literal immediately followed by `, () => {`, then a bounded gap to
  // `announceRelease({` — is unchanged, so the joint-defeat gap this guard closes
  // stays closed (see comment above).
  expect(src()).toMatch(/cron\.schedule\(\s*'40 \* \* \* \*',\s*\(\)\s*=>\s*\{[\s\S]{0,400}?announceRelease\(\{/);
});

test('src/index.ts mounts the /announce command composer', () => {
  expect(src()).toMatch(/bot\.use\([\s\S]{0,600}announceCommand,/);
});
