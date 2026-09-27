import { expect, test, vi } from 'vitest';
import { createGithubIssuesClient } from './github-issues';
import { isTransient } from '../domain/transient-error';

function stubFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
}

const client = (fetchImpl: typeof fetch) =>
  createGithubIssuesClient({ token: 'tkn', repo: 'o/r', fetchImpl });

test('listOpenIssues: filters by label, maps fields, sends auth', async () => {
  const fn = stubFetch(200, [
    { number: 228, title: 'nano-noise', body: 'strip', labels: [{ name: 'orphan-triage' }, { name: 'matcher-bug' }] },
    { number: 229, title: 'nullbody', body: null, labels: [] },
  ]);
  const issues = await client(fn).listOpenIssues('orphan-triage');
  const [url, init] = fn.mock.calls[0];
  expect(String(url)).toBe(
    'https://api.github.com/repos/o/r/issues?state=open&labels=orphan-triage&per_page=100',
  );
  const headers = init.headers as Record<string, string>;
  expect(headers.Authorization).toBe('Bearer tkn');
  expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
  expect(issues).toEqual([
    { number: 228, title: 'nano-noise', body: 'strip', labels: ['orphan-triage', 'matcher-bug'] },
    { number: 229, title: 'nullbody', body: '', labels: [] },
  ]);
});

test('createIssue: POSTs title/body/labels, returns number', async () => {
  const fn = stubFetch(201, { number: 231 });
  const n = await client(fn).createIssue({ title: 't', body: 'b', labels: ['orphan-triage'] });
  expect(n).toBe(231);
  const [url, init] = fn.mock.calls[0];
  expect(String(url)).toBe('https://api.github.com/repos/o/r/issues');
  expect(JSON.parse(init.body as string)).toEqual({ title: 't', body: 'b', labels: ['orphan-triage'] });
});

test('commentOnIssue: POSTs to comments endpoint', async () => {
  const fn = stubFetch(201, { id: 1 });
  await client(fn).commentOnIssue(228, 'hello');
  const [url, init] = fn.mock.calls[0];
  expect(String(url)).toBe('https://api.github.com/repos/o/r/issues/228/comments');
  expect(JSON.parse(init.body as string)).toEqual({ body: 'hello' });
});

test('non-2xx throws with status and response body text', async () => {
  const fn = stubFetch(403, { message: 'forbidden' });
  await expect(client(fn).listOpenIssues('orphan-triage')).rejects.toThrow(/403.*forbidden/s);
});

test('5xx is classified transient, 4xx is not', async () => {
  await expect(client(stubFetch(502, { message: 'bad gateway' })).listOpenIssues('orphan-triage'))
    .rejects.toSatisfy(isTransient);
  await expect(client(stubFetch(403, { message: 'forbidden' })).listOpenIssues('orphan-triage'))
    .rejects.toSatisfy((e: unknown) => !isTransient(e));
});

test('defaults to global fetch when fetchImpl is omitted', async () => {
  const fn = stubFetch(201, { number: 7 });
  vi.stubGlobal('fetch', fn);
  try {
    const n = await createGithubIssuesClient({ token: 'tkn', repo: 'o/r' })
      .createIssue({ title: 't', body: 'b', labels: [] });
    expect(n).toBe(7);
  } finally {
    vi.unstubAllGlobals();
  }
});

test('#431 addLabel POSTs one label and never replaces the set', async () => {
  const fn = stubFetch(200, [{ name: 'saturated' }]);
  await client(fn).addLabel(405, 'saturated');
  const [url, init] = fn.mock.calls[0];
  expect(String(url)).toBe('https://api.github.com/repos/o/r/issues/405/labels');
  expect(init.method).toBe('POST');
  // A PUT with the full set would erase human labels; assert the additive shape.
  expect(JSON.parse(init.body as string)).toEqual({ labels: ['saturated'] });
});

test('#431 removeLabel DELETEs the single named label, url-encoded', async () => {
  const fn = stubFetch(200, []);
  await client(fn).removeLabel(405, 'needs triage');
  const [url, init] = fn.mock.calls[0];
  expect(String(url)).toBe('https://api.github.com/repos/o/r/issues/405/labels/needs%20triage');
  expect(init.method).toBe('DELETE');
});

test('#431 a failing label call throws the same typed error as every other call', async () => {
  const fn = stubFetch(403, { message: 'nope' });
  await expect(client(fn).addLabel(405, 'saturated')).rejects.toMatchObject({ status: 403 });
});

test('setIssueBody PATCHes only the body', async () => {
  const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' });
  const c = createGithubIssuesClient({ token: 't', repo: 'o/r', fetchImpl: fetchImpl as unknown as typeof fetch });
  await c.setIssueBody(42, 'new body');
  const [url, init] = fetchImpl.mock.calls[0];
  expect(url).toBe('https://api.github.com/repos/o/r/issues/42');
  expect(init.method).toBe('PATCH');
  expect(JSON.parse(init.body)).toEqual({ body: 'new body' });
});

const rawIssue = (number: number, labels: string[] = ['bug']) => ({
  number, title: `Issue ${number}`, body: `Body ${number}`, state: 'open',
  labels: labels.map((name) => ({ name })), created_at: '2026-01-01T00:00:00Z',
  closed_at: null, state_reason: null, comments: 0,
});

test('listIssuesByLabels queries each label separately and unions overlapping issues', async () => {
  const fn = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify([rawIssue(12, ['bug', 'matcher-bug']), rawIssue(10)])))
    .mockResolvedValueOnce(new Response(JSON.stringify([rawIssue(12, ['bug', 'matcher-bug']), rawIssue(11, ['matcher-bug'])])));
  const result = await client(fn).listIssuesByLabels(['bug', 'matcher-bug']);
  expect(fn.mock.calls.map(([url]) => url)).toEqual([
    'https://api.github.com/repos/o/r/issues?state=all&labels=bug&per_page=100&page=1',
    'https://api.github.com/repos/o/r/issues?state=all&labels=matcher-bug&per_page=100&page=1',
  ]);
  expect(result).toEqual([
    { number: 12, title: 'Issue 12', state: 'open', labels: ['bug', 'matcher-bug'], createdAt: '2026-01-01T00:00:00Z', closedAt: null },
    { number: 11, title: 'Issue 11', state: 'open', labels: ['matcher-bug'], createdAt: '2026-01-01T00:00:00Z', closedAt: null },
    { number: 10, title: 'Issue 10', state: 'open', labels: ['bug'], createdAt: '2026-01-01T00:00:00Z', closedAt: null },
  ]);
});

test('listIssuesByLabels excludes pull requests from the issues endpoint', async () => {
  const fn = stubFetch(200, [rawIssue(12), { ...rawIssue(13), pull_request: { url: 'https://api.github.com/pulls/13' } }]);
  expect(await client(fn).listIssuesByLabels(['bug'])).toEqual([
    { number: 12, title: 'Issue 12', state: 'open', labels: ['bug'], createdAt: '2026-01-01T00:00:00Z', closedAt: null },
  ]);
});

test('listIssuesByLabels follows a full page and includes the three items on the next page', async () => {
  const first = Array.from({ length: 100 }, (_, i) => rawIssue(i + 1));
  const fn = vi.fn()
    .mockResolvedValueOnce(response(200, first))
    .mockResolvedValueOnce(response(200, [rawIssue(101), rawIssue(102), rawIssue(103)]));
  const result = await client(fn).listIssuesByLabels(['bug']);
  expect(fn.mock.calls.map(([url]) => url)).toEqual([
    'https://api.github.com/repos/o/r/issues?state=all&labels=bug&per_page=100&page=1',
    'https://api.github.com/repos/o/r/issues?state=all&labels=bug&per_page=100&page=2',
  ]);
  expect(result).toHaveLength(103);
  expect(result[0].number).toBe(103);
  expect(result[102].number).toBe(1);
});

test('getIssueWithComments fetches only pages containing the last three of 101 comments', async () => {
  const issue = { ...rawIssue(55, ['bug', 'Severity-3']), state: 'closed',
    closed_at: '2026-03-05T10:00:00Z', state_reason: 'completed', comments: 101 };
  const first = Array.from({ length: 100 }, (_, i) => ({
    body: `Comment ${i + 1}`, created_at: '2026-03-01T00:00:00Z',
  }));
  const fn = vi.fn()
    .mockResolvedValueOnce(response(200, issue))
    .mockResolvedValueOnce(response(200, first))
    .mockResolvedValueOnce(response(200, [{ body: 'Comment 101', created_at: '2026-03-02T00:00:00Z' }]));
  const result = await client(fn).getIssueWithComments(55, 3);
  expect(fn.mock.calls.map(([url]) => url)).toEqual([
    'https://api.github.com/repos/o/r/issues/55',
    'https://api.github.com/repos/o/r/issues/55/comments?per_page=100&page=1',
    'https://api.github.com/repos/o/r/issues/55/comments?per_page=100&page=2',
  ]);
  expect(result).toEqual({
    number: 55, title: 'Issue 55', state: 'closed', labels: ['bug', 'Severity-3'],
    createdAt: '2026-01-01T00:00:00Z', closedAt: '2026-03-05T10:00:00Z',
    stateReason: 'completed', body: 'Body 55', comments: [
      { body: 'Comment 99', createdAt: '2026-03-01T00:00:00Z' },
      { body: 'Comment 100', createdAt: '2026-03-01T00:00:00Z' },
      { body: 'Comment 101', createdAt: '2026-03-02T00:00:00Z' },
    ],
  });
});

test('getIssueWithComments makes no comments request when count is zero', async () => {
  const fn = stubFetch(200, rawIssue(55));
  const result = await client(fn).getIssueWithComments(55, 3);
  expect(fn.mock.calls.map(([url]) => url)).toEqual(['https://api.github.com/repos/o/r/issues/55']);
  expect(result.comments).toEqual([]);
});

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
