export interface GithubCloseoutIssue {
  number: number;
  state: 'open' | 'closed';
  labels: string[];
  isPullRequest: boolean;
}

export interface GithubCloseoutClient {
  getIssue(number: number): Promise<GithubCloseoutIssue>;
  closeIssue(number: number): Promise<void>;
}

export function createGithubCloseoutClient(cfg: {
  token: string; repo: string; fetchImpl?: typeof fetch;
}): GithubCloseoutClient {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const base = `https://api.github.com/repos/${cfg.repo}/issues`;
  const headers = {
    Authorization: `Bearer ${cfg.token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'warsaw-beer-bot-closeout',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  async function request(number: number, init?: RequestInit): Promise<unknown> {
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error('invalid GitHub issue number');
    const response = await fetchImpl(`${base}/${number}`, { ...init, headers });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`GitHub ${init?.method ?? 'GET'} issue ${number}: ${response.status} ${body.slice(0, 300)}`);
    }
    return response.json();
  }
  return {
    async getIssue(number) {
      const raw = await request(number) as {
        number?: unknown; state?: unknown; labels?: { name?: unknown }[]; pull_request?: unknown;
      };
      if (raw.number !== number || (raw.state !== 'open' && raw.state !== 'closed')
        || !Array.isArray(raw.labels) || raw.labels.some((label) => typeof label.name !== 'string')) {
        throw new Error(`GitHub issue ${number}: malformed response`);
      }
      return {
        number, state: raw.state, labels: raw.labels.map((label) => label.name as string),
        isPullRequest: raw.pull_request !== undefined,
      };
    },
    async closeIssue(number) {
      const raw = await request(number, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) }) as
        { state?: unknown };
      if (raw.state !== 'closed') throw new Error(`GitHub issue ${number}: close not confirmed`);
    },
  };
}
