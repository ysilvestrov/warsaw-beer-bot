import { createGithubCloseoutClient } from './github-closeout';

it('reads the current GitHub issue and PATCHes only its closed state', async () => {
  const calls: { method: string; url: string; body: string | undefined }[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url: String(input), body: init?.body as string | undefined });
    if (init?.method === 'PATCH') return new Response(JSON.stringify({ state: 'closed' }), { status: 200 });
    return new Response(JSON.stringify({ number: 697, state: 'open', labels: [{ name: 'orphan-triage' }] }), { status: 200 });
  };
  const client = createGithubCloseoutClient({ token: 'test-token', repo: 'owner/repo', fetchImpl: fetchImpl as typeof fetch });
  expect(await client.getIssue(697)).toEqual({ number: 697, state: 'open', labels: ['orphan-triage'], isPullRequest: false });
  await client.closeIssue(697);
  expect(calls).toEqual([
    { method: 'GET', url: 'https://api.github.com/repos/owner/repo/issues/697', body: undefined },
    { method: 'PATCH', url: 'https://api.github.com/repos/owner/repo/issues/697', body: '{"state":"closed"}' },
  ]);
});
