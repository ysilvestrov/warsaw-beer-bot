import pino from 'pino';
import { expect, test, vi } from 'vitest';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { upsertBeer } from '../storage/beers';
import { normalizeName, normalizeBrewery } from '../domain/normalize';
import { getJobState } from '../storage/job_state';
import { recordEnrichFailure } from '../storage/enrich_failures';
import {
  orphanTriage, shouldRunTriage, buildTriageLine,
  TRIAGE_LAST_RUN_KEY, TRIAGE_LAST_RESULT_KEY,
} from './orphan-triage';
import type { Analysis } from '../domain/triage-analysis';

const log = pino({ level: 'silent' });
// Warsaw 07:30 on 2026-07-05 (CEST = UTC+2) → 05:30Z
const inWindow = () => new Date('2026-07-05T05:30:00Z');

function db() {
  const d = openDb(':memory:');
  migrate(d);
  return d;
}

// Word-based names: numeric suffixes get stripped as noise by normalization,
// which would collapse all seeded beers into one upserted row.
const BEER_WORDS = ['one', 'two', 'three', 'four', 'five', 'six'];
function insertBeer(d: ReturnType<typeof db>, n: number) {
  const name = `Beer ${BEER_WORDS[n - 1]}`;
  const brewery = `Craft ${BEER_WORDS[n - 1]}`;
  return upsertBeer(d, {
    untappd_id: null, name, brewery, style: null, abv: null, rating_global: null,
    normalized_name: normalizeName(name), normalized_brewery: normalizeBrewery(brewery),
  });
}

// Insert a beers row + enrich failure.
function seedOrphan(d: ReturnType<typeof db>, beerId: number) {
  insertBeer(d, beerId);
  recordEnrichFailure(d, {
    beer_id: beerId, brewery: `Br${beerId}`, name: `Beer${beerId}`,
    search_url: 'u', source_url: '', outcome: 'not_found',
    candidates_count: 0, candidates_summary: '', at: `2026-07-0${beerId}T00:00:00Z`,
  });
}

const gh = (over = {}) => ({
  listOpenIssues: vi.fn().mockResolvedValue([{ number: 228, title: 't', body: 'b', labels: [] }]),
  createIssue: vi.fn().mockResolvedValue(231),
  commentOnIssue: vi.fn().mockResolvedValue(undefined),
  ...over,
});
const llm = (analysis: Analysis) => ({ analyze: vi.fn().mockResolvedValue(analysis) });

test('shouldRunTriage: window and idempotency', () => {
  expect(shouldRunTriage({ now: inWindow(), lastRunDate: null }))
    .toEqual({ run: true, dateKey: '2026-07-05' });
  expect(shouldRunTriage({ now: inWindow(), lastRunDate: '2026-07-05' }).run).toBe(false);
  // 10:30 Warsaw = 08:30Z → outside [6,9)
  expect(shouldRunTriage({ now: new Date('2026-07-05T08:30:00Z'), lastRunDate: null }).run).toBe(false);
});

test('happy path: comment + new issue + quiet; DB and job_state written', async () => {
  const d = db();
  [1, 2, 3].forEach((n) => seedOrphan(d, n));
  const analysis: Analysis = {
    verdicts: [
      { beer_id: 3, review_class: 'matcher_bug', review_note: 'alias', issue_number: 228, new_issue_key: null },
      { beer_id: 2, review_class: 'parser_bug', review_note: 'merch', issue_number: null, new_issue_key: 'k1' },
      { beer_id: 1, review_class: 'not_on_untappd', review_note: 'small batch', issue_number: null, new_issue_key: null },
    ],
    new_issues: [{ key: 'k1', title: 'Adapter noise', body: 'b', labels: [] }],
  };
  const github = gh();
  await orphanTriage({ db: d, log, llm: llm(analysis), github, now: inWindow });

  expect(github.commentOnIssue).toHaveBeenCalledTimes(1);
  expect(github.createIssue).toHaveBeenCalledWith(
    expect.objectContaining({ labels: ['orphan-triage', 'parser-bug'] }),
  );
  const rows = d.prepare(
    'SELECT beer_id, review_class, review_note FROM enrich_failures ORDER BY beer_id',
  ).all() as { beer_id: number; review_class: string; review_note: string }[];
  expect(rows.map((r) => r.review_class)).toEqual(['not_on_untappd', 'parser_bug', 'matcher_bug']);
  expect(rows[1].review_note).toBe('merch → #231');
  expect(rows[2].review_note).toBe('alias → #228');
  expect(getJobState(d, TRIAGE_LAST_RUN_KEY)).toBe('2026-07-05');
  const result = JSON.parse(getJobState(d, TRIAGE_LAST_RESULT_KEY)!);
  expect(result.date).toBe('2026-07-05');
  expect(result.line).toContain('3 нових');
});

test('github comment failure: affected orphan stays untriaged, others proceed', async () => {
  const d = db();
  [1, 2].forEach((n) => seedOrphan(d, n));
  const analysis: Analysis = {
    verdicts: [
      { beer_id: 1, review_class: 'matcher_bug', review_note: 'x', issue_number: 228, new_issue_key: null },
      { beer_id: 2, review_class: 'wontfix', review_note: 'y', issue_number: null, new_issue_key: null },
    ],
    new_issues: [],
  };
  const github = gh({ commentOnIssue: vi.fn().mockRejectedValue(new Error('boom')) });
  await orphanTriage({ db: d, log, llm: llm(analysis), github, now: inWindow });
  const cls = (id: number) => (d.prepare(
    'SELECT review_class FROM enrich_failures WHERE beer_id = ?',
  ).get(id) as { review_class: string | null }).review_class;
  expect(cls(1)).toBeNull();   // GitHub failed → no DB write
  expect(cls(2)).toBe('wontfix');
  const result = JSON.parse(getJobState(d, TRIAGE_LAST_RESULT_KEY)!);
  expect(result.line).toContain('пропущено');
});

test('LLM failure: nothing written except error result line', async () => {
  const d = db();
  seedOrphan(d, 1);
  const github = gh();
  await orphanTriage({
    db: d, log, github, now: inWindow,
    llm: { analyze: vi.fn().mockRejectedValue(new Error('invalid json')) },
  });
  expect(github.createIssue).not.toHaveBeenCalled();
  expect(JSON.parse(getJobState(d, TRIAGE_LAST_RESULT_KEY)!).line).toContain('помилка');
  // run is still marked so we don't hammer a broken LLM every 15 min
  expect(getJobState(d, TRIAGE_LAST_RUN_KEY)).toBe('2026-07-05');
});

test('disabled (no llm/github): skip line written once', async () => {
  const d = db();
  await orphanTriage({ db: d, log, llm: null, github: null, now: inWindow });
  expect(JSON.parse(getJobState(d, TRIAGE_LAST_RESULT_KEY)!).line).toContain('вимкнено');
});

test('no untriaged orphans: nothing-to-do line, no LLM call', async () => {
  const d = db();
  const theLlm = llm({ verdicts: [], new_issues: [] });
  const github = gh();
  await orphanTriage({ db: d, log, llm: theLlm, github, now: inWindow });
  expect(theLlm.analyze).not.toHaveBeenCalled();
  expect(github.listOpenIssues).not.toHaveBeenCalled();
  expect(JSON.parse(getJobState(d, TRIAGE_LAST_RESULT_KEY)!).line).toContain('0 нових');
});

test('buildTriageLine formats counts', () => {
  expect(buildTriageLine({
    total: 7, commented: [{ issueNumber: 228, count: 2 }], created: [{ issueNumber: 232, count: 1 }],
    notOnUntappd: 3, wontfix: 0, skipped: 1, error: null, disabledReason: null,
  })).toBe('Тріаж: 7 нових → 2 до #228, 1 нова #232, 3 not_on_untappd, 1 пропущено');
  expect(buildTriageLine({
    total: 0, commented: [], created: [], notOnUntappd: 0, wontfix: 0,
    skipped: 0, error: 'invalid json', disabledReason: null,
  })).toBe('Тріаж: помилка (invalid json)');
  expect(buildTriageLine({
    total: 0, commented: [], created: [], notOnUntappd: 0, wontfix: 0,
    skipped: 0, error: null, disabledReason: 'нема GITHUB_TOKEN',
  })).toBe('Тріаж: вимкнено (нема GITHUB_TOKEN)');
});
