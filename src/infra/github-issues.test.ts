import { afterEach, expect, test, vi } from 'vitest';
import { createGithubIssuesClient } from './github-issues';

afterEach(() => vi.unstubAllGlobals());

const client = () => createGithubIssuesClient({ token: 'tkn', repo: 'o/r' });

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

test('listOpenIssues: filters by label, maps fields, sends auth', async () => {
  const fn = stubFetch(200, [
    { number: 228, title: 'nano-noise', body: 'strip', labels: [{ name: 'orphan-triage' }, { name: 'matcher-bug' }] },
    { number: 229, title: 'nullbody', body: null, labels: [] },
  ]);
  const issues = await client().listOpenIssues('orphan-triage');
  const [url, init] = fn.mock.calls[0];
  expect(String(url)).toBe(
    'https://api.github.com/repos/o/r/issues?state=open&labels=orphan-triage&per_page=100',
  );
  expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tkn');
  expect(issues).toEqual([
    { number: 228, title: 'nano-noise', body: 'strip', labels: ['orphan-triage', 'matcher-bug'] },
    { number: 229, title: 'nullbody', body: '', labels: [] },
  ]);
});

test('createIssue: POSTs title/body/labels, returns number', async () => {
  const fn = stubFetch(201, { number: 231 });
  const n = await client().createIssue({ title: 't', body: 'b', labels: ['orphan-triage'] });
  expect(n).toBe(231);
  const [url, init] = fn.mock.calls[0];
  expect(String(url)).toBe('https://api.github.com/repos/o/r/issues');
  expect(JSON.parse(init.body as string)).toEqual({ title: 't', body: 'b', labels: ['orphan-triage'] });
});

test('commentOnIssue: POSTs to comments endpoint', async () => {
  const fn = stubFetch(201, { id: 1 });
  await client().commentOnIssue(228, 'hello');
  const [url, init] = fn.mock.calls[0];
  expect(String(url)).toBe('https://api.github.com/repos/o/r/issues/228/comments');
  expect(JSON.parse(init.body as string)).toEqual({ body: 'hello' });
});

test('non-2xx throws with status', async () => {
  stubFetch(403, { message: 'forbidden' });
  await expect(client().listOpenIssues('orphan-triage')).rejects.toThrow(/403/);
});
