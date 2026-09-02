import { readFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { upsertBeer, getBeer } from '../storage/beers';
import { recordEnrichFailure, setEnrichFailureReview, retireEnrichFailure, markUnrescued } from '../storage/enrich_failures';
import { getJobState } from '../storage/job_state';
import type { GithubIssuesClient } from '../infra/github-issues';
import { unlockFixedOrphans, UNLOCK_LAST_RUN_KEY } from './unlock-fixed-orphans';

const log = pino({ level: 'silent' });
const NOW = () => new Date('2026-08-16T07:00:00Z');

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

// Only listOpenIssues is exercised; the other methods throw so an accidental call is
// loud rather than silently satisfied by a no-op stub.
function stubGithub(open: { number: number }[]): GithubIssuesClient {
  return {
    listOpenIssues: async () => open.map((i) => ({
      number: i.number, title: '', body: '', labels: ['orphan-triage'],
      createdAt: '2026-01-01T00:00:00Z',
    })),
    createIssue: async () => { throw new Error('unexpected createIssue'); },
    commentOnIssue: async () => { throw new Error('unexpected commentOnIssue'); },
    addLabel: async () => { throw new Error('unexpected addLabel'); },
    removeLabel: async () => { throw new Error('unexpected removeLabel'); },
    setIssueBody: async () => { throw new Error('unexpected setIssueBody'); },
  };
}

// An orphan with a failure row and an actionable verdict — the shape every locked row has.
function seedLocked(
  db: ReturnType<typeof fresh>,
  name: string,
  cls: 'matcher_bug' | 'parser_bug',
  issue: number | null,
): number {
  const beerId = upsertBeer(db, {
    untappd_id: null, name, brewery: 'Mad Brew', style: null, abv: null, rating_global: null,
    normalized_name: name.toLowerCase(), normalized_brewery: 'mad brew',
  });
  recordEnrichFailure(db, {
    beer_id: beerId, brewery: 'Mad Brew', name,
    search_url: '', source_url: '', outcome: 'not_found',
    candidates_count: 3, candidates_summary: '', at: '2026-08-01T00:00:00Z',
  });
  const written = setEnrichFailureReview(db, beerId, cls, 'note', '2026-08-01T01:00:00Z', issue);
  expect(written).toBe('written');
  return beerId;
}

describe('unlockFixedOrphans', () => {
  // Red if the job stops comparing against the open set: rows whose fix shipped would stay
  // locked forever, which is the permanent seal #377 spent a whole design removing.
  it('unlocks rows whose issue left the open set and re-arms their backoff', async () => {
    const db = fresh();
    const closedIssue = seedLocked(db, 'Bitter Cost', 'matcher_bug', 347);
    const stillOpen = seedLocked(db, 'Cyrillic Row', 'parser_bug', 376);
    db.prepare('UPDATE beers SET untappd_lookup_count = 3, untappd_lookup_at = ? WHERE id = ?')
      .run('2026-08-01T00:00:00Z', closedIssue);

    const out = await unlockFixedOrphans({ db, log, github: stubGithub([{ number: 376 }]), now: NOW });

    expect(out.unlocked).toBe(1);
    const row = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = ?').get(closedIssue) as any;
    expect(row.unlocked_at).toBe('2026-08-16T07:00:00.000Z');
    expect(row.review_class).toBe('matcher_bug'); // beat 1 keeps the verdict: it is the bet
    const beer = getBeer(db, closedIssue);
    expect(beer?.untappd_lookup_count).toBe(0);
    expect(beer?.untappd_lookup_at).toBeNull();
    // #376 is still open, so its row is untouched.
    const untouched = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = ?').get(stillOpen) as any;
    expect(untouched.unlocked_at).toBeNull();
  });

  // Red if the pagination guard is removed. listOpenIssues fetches per_page=100 with no
  // pagination, so a full page may be a TRUNCATED open set — and acting on a truncated open
  // set unlocks rows corpus-wide, silently, in one run.
  it('unlocks nothing when the open-issue page comes back full', async () => {
    const db = fresh();
    seedLocked(db, 'Bitter Cost', 'matcher_bug', 347);
    const hundred = Array.from({ length: 100 }, (_, i) => ({ number: 1000 + i }));

    const out = await unlockFixedOrphans({ db, log, github: stubGithub(hundred), now: NOW });

    expect(out.unlocked).toBe(0);
    expect(out.skippedReason).toBe('open_issue_page_full');
    // And the day is not closed, so the next tick can still do the real work.
    expect(getJobState(db, UNLOCK_LAST_RUN_KEY)).toBeNull();
  });

  // Red if job_state idempotency is dropped: the job would re-arm the same rows on every
  // tick, resetting the backoff of rows legitimately working through their retries.
  it('runs once per Warsaw day', async () => {
    const db = fresh();
    seedLocked(db, 'Bitter Cost', 'matcher_bug', 347);
    const deps = { db, log, github: stubGithub([]), now: NOW };

    expect((await unlockFixedOrphans(deps)).unlocked).toBe(1);
    const second = await unlockFixedOrphans(deps);
    expect(second.unlocked).toBe(0);
    expect(second.skippedReason).toBe('done_today');
  });

  // Red if a GitHub failure is allowed to close the day: one 502 would cost every locked row
  // a full day of reachability — the failure mode #316 fixed for triage.
  it('does not close the day when GitHub fails', async () => {
    const db = fresh();
    seedLocked(db, 'Bitter Cost', 'matcher_bug', 347);
    const failing = {
      listOpenIssues: async () => { throw new Error('GitHub GET: 502'); },
      createIssue: async () => { throw new Error('unexpected'); },
      commentOnIssue: async () => { throw new Error('unexpected'); },
      addLabel: async () => { throw new Error('unexpected addLabel'); },
      removeLabel: async () => { throw new Error('unexpected removeLabel'); },
      setIssueBody: async () => { throw new Error('unexpected setIssueBody'); },
    } as GithubIssuesClient;

    const first = await unlockFixedOrphans({ db, log, github: failing, now: NOW });
    expect(first.error).toContain('502');
    expect(getJobState(db, UNLOCK_LAST_RUN_KEY)).toBeNull();

    const second = await unlockFixedOrphans({ db, log, github: stubGithub([]), now: NOW });
    expect(second.unlocked).toBe(1);
  });

  // Red if the job selects on class alone. A verdict with no issue names no fix, so "the fix
  // shipped" is not a claim anything could make about it — and unlocking it would be noise.
  it('ignores rows with no issue_number', async () => {
    const db = fresh();
    seedLocked(db, 'Legacy Row', 'matcher_bug', null);

    const out = await unlockFixedOrphans({ db, log, github: stubGithub([]), now: NOW });

    expect(out.unlocked).toBe(0);
  });

  // Red if `retired_at IS NULL` is dropped from listLockedRows. retireEnrichFailure PRESERVES
  // review_class (deliberately, for audit), so a retired row still looks actionable — but it
  // is held out of the pools by retired_at, not by the lock. Unlocking it stamps unlocked_at
  // and resets the backoff for a retry that can never run, silently spending the row's one
  // bet and leaving it marked in-flight forever, since beat 2 needs a failure that never
  // comes. This is the invariant listLockedRows' own comment promises: it must list exactly
  // the rows the lock holds.
  it('ignores a retired row even though it kept its actionable verdict', async () => {
    const db = fresh();
    const id = seedLocked(db, 'Bitter Cost', 'parser_bug', 376);
    expect(retireEnrichFailure(db, id, 'resolved by a shipped fix', '2026-08-10T00:00:00Z')).toBe(true);
    db.prepare('UPDATE beers SET untappd_lookup_count = 3 WHERE id = ?').run(id);

    const out = await unlockFixedOrphans({ db, log, github: stubGithub([]), now: NOW });

    expect(out.unlocked).toBe(0);
    const row = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = ?').get(id) as any;
    expect(row.unlocked_at).toBeNull();
    expect(getBeer(db, id)?.untappd_lookup_count).toBe(3); // backoff untouched
  });

  // Red if the job re-unlocks a row that already spent its free retry: unlocked_at is the
  // only thing standing between "one bet per shipped fix" and an unbounded re-arm loop.
  it('does not unlock a row whose free retry is already in flight', async () => {
    const db = fresh();
    const id = seedLocked(db, 'Bitter Cost', 'matcher_bug', 347);
    db.prepare('UPDATE enrich_failures SET unlocked_at = ? WHERE beer_id = ?')
      .run('2026-08-15T06:00:00.000Z', id);

    const out = await unlockFixedOrphans({ db, log, github: stubGithub([]), now: NOW });

    expect(out.unlocked).toBe(0);
    const row = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = ?').get(id) as any;
    expect(row.unlocked_at).toBe('2026-08-15T06:00:00.000Z');
  });

  // Обидві сироти під замком на issue 700, яка вже НЕ у відкритому наборі (stubGithub([])).
  it('unlocks a marked row but does NOT re-arm it — the closure cannot rescue it', async () => {
    const db = fresh();
    const beerId = seedLocked(db, 'frozen', 'parser_bug', 700);
    db.prepare('UPDATE beers SET untappd_lookup_count = 3, untappd_lookup_at = ? WHERE id = ?')
      .run('2026-08-01T00:00:00Z', beerId);
    expect(markUnrescued(db, beerId, 700, '2026-09-01T00:00:00Z')).toBe(true);

    const out = await unlockFixedOrphans({ db, log, github: stubGithub([]), now: NOW });

    expect(out.unlocked).toBe(1);
    expect(out.rearmSkipped).toBe(1);
    const beer = getBeer(db, beerId)!;
    expect(beer.untappd_lookup_count).toBe(3);            // лічильник НЕ обнулено
    expect(beer.untappd_lookup_at).toBe('2026-08-01T00:00:00Z');
    const row = db.prepare('SELECT unlocked_at, unrescued_at FROM enrich_failures WHERE beer_id = ?')
      .get(beerId) as { unlocked_at: string | null; unrescued_at: string | null };
    expect(row.unlocked_at).not.toBeNull();               // замок усе одно знято
    expect(row.unrescued_at).not.toBeNull();              // маркер лишається
  });

  it('still re-arms an unmarked row', async () => {
    const db = fresh();
    const beerId = seedLocked(db, 'ordinary', 'matcher_bug', 700);
    db.prepare('UPDATE beers SET untappd_lookup_count = 3, untappd_lookup_at = ? WHERE id = ?')
      .run('2026-08-01T00:00:00Z', beerId);

    const out = await unlockFixedOrphans({ db, log, github: stubGithub([]), now: NOW });

    expect(out.rearmSkipped).toBe(0);
    const beer = getBeer(db, beerId)!;
    expect(beer.untappd_lookup_count).toBe(0);
    expect(beer.untappd_lookup_at).toBeNull();
  });

  // #558: маркер знімає лише безкоштовне обнулення бекофу. Щойно він потрапить у предикат
  // пулу, рядок зникне з обігу — рівно те, що #412 вже коштувало 157 рядків.
  it('no pool predicate reads the unrescued marker', () => {
    const src = readFileSync(path.join(__dirname, '../storage/beers.ts'), 'utf8');
    for (const name of ['orphanNotOnTapPredicate', 'onLatestTapPredicate', 'lockedRowPredicate']) {
      const start = src.indexOf(`export const ${name}`);
      expect(start, `${name} not found`).toBeGreaterThan(-1);
      const body = src.slice(start, src.indexOf('`;', start));
      expect(body).not.toContain('unrescued');
    }
  });
});
