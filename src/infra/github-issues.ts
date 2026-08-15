import type { OpenIssue } from '../domain/triage-analysis';
import { HttpStatusError } from '../domain/transient-error';

export interface GithubIssuesClient {
  listOpenIssues(label: string): Promise<OpenIssue[]>;
  createIssue(i: { title: string; body: string; labels: string[] }): Promise<number>;
  commentOnIssue(issueNumber: number, body: string): Promise<void>;
}

// Minimal GitHub REST client (plain fetch, same style as scripts/ai-pr-review.ts).
// The triage job files at most a handful of requests per day, so no pagination
// beyond per_page=100 and no rate-limit handling — a failure surfaces in the
// digest and retries tomorrow.
export function createGithubIssuesClient(cfg: {
  token: string;
  repo: string;
  fetchImpl?: typeof fetch;
}): GithubIssuesClient {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const base = `https://api.github.com/repos/${cfg.repo}`;
  const headers = {
    Authorization: `Bearer ${cfg.token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'warsaw-beer-bot-triage',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  async function call<T>(url: string, init?: RequestInit): Promise<T> {
    // NOTE: `headers` wins over `init` here — callers must not pass init.headers.
    const res = await fetchImpl(url, { ...init, headers });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // Typed so the caller (orphan-triage) can tell a retriable 5xx from a
      // permanent 4xx without parsing this message. Text is unchanged: it goes
      // into the daily digest.
      throw new HttpStatusError(
        `GitHub ${init?.method ?? 'GET'} ${url}: ${res.status}${text ? ` ${text.slice(0, 300)}` : ''}`,
        res.status,
      );
    }
    return res.json() as Promise<T>;
  }

  return {
    async listOpenIssues(label) {
      type Raw = {
        number: number; title: string; body: string | null;
        labels: { name: string }[]; created_at: string;
      };
      const raw = await call<Raw[]>(`${base}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100`);
      return raw.map((r) => ({
        number: r.number,
        title: r.title,
        body: r.body ?? '',
        labels: r.labels.map((l) => l.name),
        // #408 saturation counts rows attached AFTER the issue existed, so the guard
        // needs the creation instant — an issue born from a split legitimately starts
        // life carrying a large enumerated cohort.
        createdAt: r.created_at,
      }));
    },
    async createIssue(i) {
      const r = await call<{ number: number }>(`${base}/issues`, {
        method: 'POST',
        body: JSON.stringify(i),
      });
      return r.number;
    },
    async commentOnIssue(issueNumber, body) {
      await call(`${base}/issues/${issueNumber}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      });
    },
  };
}
