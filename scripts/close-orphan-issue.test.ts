import { openDb } from '../src/storage/db';
import { migrate } from '../src/storage/schema';
import type { GithubCloseoutClient } from '../src/infra/github-closeout';
import { parseCloseArgs, runCloseOrphanIssue } from './close-orphan-issue';

function fixture() {
  const db = openDb(':memory:');
  migrate(db);
  let closes = 0;
  let reads = 0;
  const github: GithubCloseoutClient = {
    getIssue: async (number) => {
      reads += 1;
      return { number, state: closes ? 'closed' : 'open', labels: ['orphan-triage'], isPullRequest: false };
    },
    closeIssue: async () => { closes += 1; },
  };
  const lines: string[] = [];
  return { db, github, lines, print: (line: string) => lines.push(line),
    closes: () => closes, reads: () => reads };
}

it('requires an explicit issue and close flag', () => {
  expect(parseCloseArgs(['--issue', '697'])).toEqual({ issue: 697, close: false });
  expect(parseCloseArgs(['--issue', '697', '--close'])).toEqual({ issue: 697, close: true });
  for (const argv of [[], ['--issue', '0'], ['--issue', '697', '--issue', '698'],
    ['--issue', '697', '--apply'], ['--close']]) {
    expect(() => parseCloseArgs(argv)).toThrow();
  }
});

it('dry-runs without PATCH and closes only after a second successful preflight', async () => {
  const f = fixture();
  expect(await runCloseOrphanIssue(['--issue', '697'], f)).toBe(0);
  expect(f.closes()).toBe(0);
  expect(JSON.parse(f.lines[0])).toMatchObject({ issueNumber: 697, ready: true, rows: [] });
  expect(await runCloseOrphanIssue(['--issue', '697', '--close'], f)).toBe(0);
  expect(f.closes()).toBe(1);
  expect(f.reads()).toBe(4); // one dry run; two preflights and post-close check
});

it('refuses to close when a new row appears during the second preflight', async () => {
  const f = fixture();
  let reads = 0;
  f.github.getIssue = async (number) => {
    reads += 1;
    if (reads === 2) {
      f.db.prepare(`INSERT INTO beers (id, brewery, name, normalized_brewery, normalized_name)
        VALUES (1, 'B', 'N', 'b', 'n')`).run();
      f.db.prepare(`INSERT INTO enrich_failures
        (beer_id, brewery, name, search_url, outcome, candidates_count, candidates_summary,
         fail_count, last_at, review_class, issue_number)
        VALUES (1, 'B', 'N', '', 'not_found', 0, '', 1,
          '2026-09-24T10:00:00Z', 'parser_bug', 697)`).run();
    }
    return { number, state: 'open', labels: ['orphan-triage'], isPullRequest: false };
  };
  expect(await runCloseOrphanIssue(['--issue', '697', '--close'], f)).toBe(1);
  expect(f.closes()).toBe(0);
});

it('reports a row arriving after PATCH as incomplete closeout', async () => {
  const f = fixture();
  // Simulate the GitHub state changing with the PATCH while DB receives a late row.
  let closed = false;
  f.github.closeIssue = async () => {
    closed = true;
    f.db.prepare(`INSERT INTO beers (id, brewery, name, normalized_brewery, normalized_name)
      VALUES (1, 'B', 'N', 'b', 'n')`).run();
    f.db.prepare(`INSERT INTO enrich_failures
      (beer_id, brewery, name, search_url, outcome, candidates_count, candidates_summary,
       fail_count, last_at, review_class, issue_number)
      VALUES (1, 'B', 'N', '', 'not_found', 0, '', 1,
        '2026-09-24T10:00:00Z', 'parser_bug', 697)`).run();
  };
  f.github.getIssue = async (number) => ({ number, state: closed ? 'closed' : 'open',
    labels: ['orphan-triage'], isPullRequest: false });
  expect(await runCloseOrphanIssue(['--issue', '697', '--close'], f)).toBe(1);
  expect(JSON.parse(f.lines.at(-1)!)).toMatchObject({ closed: true, ready: false,
    rows: [{ beerId: 1, state: 'blocked' }] });
});

it('does not report closed when post-PATCH GitHub still says open', async () => {
  const f = fixture();
  f.github.getIssue = async (number) => ({ number, state: 'open',
    labels: ['orphan-triage'], isPullRequest: false });
  expect(await runCloseOrphanIssue(['--issue', '697', '--close'], f)).toBe(1);
  expect(JSON.parse(f.lines.at(-1)!)).toMatchObject({ closed: false, ready: false });
});

it('refuses a closed issue, a missing label, and a PR number', async () => {
  for (const issue of [
    { state: 'closed' as const, labels: ['orphan-triage'], isPullRequest: false },
    { state: 'open' as const, labels: [], isPullRequest: false },
    { state: 'open' as const, labels: ['orphan-triage'], isPullRequest: true },
  ]) {
    const f = fixture();
    f.github.getIssue = async (number) => ({ number, ...issue });
    expect(await runCloseOrphanIssue(['--issue', '697', '--close'], f)).toBe(1);
    expect(f.closes()).toBe(0);
  }
});
