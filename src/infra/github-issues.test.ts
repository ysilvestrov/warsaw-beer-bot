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
