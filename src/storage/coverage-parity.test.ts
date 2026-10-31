import { describe, it, expect } from 'vitest';
import { openDb } from './db';
import { migrate } from './schema';
import { ensureProfile } from './user_profiles';
import { addCoverage, coverageFor } from './checkin_coverage';
import { mergeRange, type CoverageRange } from '../shared/checkin-sync/coverage';

// #924: the extension keeps coverage in IndexedDB through the pure mergeRange, the server keeps
// it in SQLite through addCoverage. Both must claim exactly the same coverage, or local mode
// would skip or re-walk different parts of the feed. Two independent implementations compared
// step by step on seeded random walks; coverage.test.ts pins the rule itself.
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('mergeRange vs addCoverage', () => {
  it('agree after every step of 500 random sequences', () => {
    const rand = prng(924);
    // Every step is recorded, matching or not, and compared in one assertion: no branch on the
    // result under test (CLAUDE.md testing rule (b)).
    const sqlSteps: string[] = [];
    const pureSteps: string[] = [];
    // One database; each sequence is its own user, so coverage starts empty without a re-migrate.
    const db = openDb(':memory:');
    migrate(db);
    for (let seq = 0; seq < 500; seq++) {
      const user = seq + 1;
      ensureProfile(db, user);
      let pure: CoverageRange[] = [];
      const steps = 1 + Math.floor(rand() * 12);
      for (let step = 0; step < steps; step++) {
        const a = 1 + Math.floor(rand() * 400);
        const b = a + Math.floor(rand() * 40);
        addCoverage(db, user, a, b);
        pure = mergeRange(pure, a, b);
        const label = `seq ${seq} step ${step} +${a}..${b}`;
        sqlSteps.push(`${label}: ${JSON.stringify(coverageFor(db, user))}`);
        pureSteps.push(`${label}: ${JSON.stringify(pure)}`);
      }
    }
    expect(sqlSteps).toEqual(pureSteps);
  });
});
