import type { OpenIssue } from '../domain/triage-analysis';
import type { BugReportGithub, IssueCandidate, IssueDetail } from '../domain/bug-report-types';
import { HttpStatusError } from '../domain/transient-error';

export interface GithubIssuesClient {
  listOpenIssues(label: string): Promise<OpenIssue[]>;
  createIssue(i: { title: string; body: string; labels: string[] }): Promise<number>;
  commentOnIssue(issueNumber: number, body: string): Promise<void>;
  // #431: additive label mutation only. GitHub also offers PUT .../labels, which
  // REPLACES the whole set — that would silently erase labels a human applied
  // (priority/tier-2, extension-bug) every time the triage job reconciled.
  addLabel(issueNumber: number, label: string): Promise<void>;
  removeLabel(issueNumber: number, label: string): Promise<void>;
  // #509: PATCH with ONLY `body`. The issues endpoint replaces every field it is given, so
  // sending title or labels here would overwrite whatever a human has since set — the same
  // hazard the addLabel/removeLabel comment above describes for PUT .../labels.
  setIssueBody(issueNumber: number, body: string): Promise<void>;
}

// Minimal GitHub REST client (plain fetch, same style as scripts/ai-pr-review.ts).
// The triage job files at most a handful of requests per day, so no pagination
// beyond per_page=100 and no rate-limit handling — a failure surfaces in the
// digest and retries tomorrow.
export function createGithubIssuesClient(cfg: {
  token: string;
  repo: string;
  fetchImpl?: typeof fetch;
}): GithubIssuesClient & BugReportGithub {
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
    async listIssuesByLabels(labels) {
      type Raw = {
        number: number; title: string; state: IssueCandidate['state'];
        labels: { name: string }[]; created_at: string; closed_at: string | null;
        pull_request?: unknown;
      };
      const byNumber = new Map<number, IssueCandidate>();
      for (const label of labels) {
        let page = 1;
        let raw: Raw[];
        do {
          raw = await call<Raw[]>(
            `${base}/issues?state=all&labels=${encodeURIComponent(label)}&per_page=100&page=${page}`,
          );
          for (const issue of raw) {
            if (issue.pull_request) continue;
            byNumber.set(issue.number, {
              number: issue.number, title: issue.title, state: issue.state,
              labels: issue.labels.map((item) => item.name), createdAt: issue.created_at,
              closedAt: issue.closed_at,
            });
          }
          page += 1;
        } while (raw.length === 100);
      }
      return [...byNumber.values()].sort((a, b) => b.number - a.number);
    },
    async getIssueWithComments(issueNumber, lastComments) {
      type RawIssue = {
        number: number; title: string; body: string | null;
        state: IssueDetail['state']; state_reason: IssueDetail['stateReason'];
        labels: { name: string }[]; created_at: string; closed_at: string | null;
        comments: number;
      };
      type RawComment = { body: string | null; created_at: string };
      const issue = await call<RawIssue>(`${base}/issues/${issueNumber}`);
      const comments: RawComment[] = [];
      if (lastComments > 0 && issue.comments > 0) {
        const firstPage = Math.max(1, Math.floor((issue.comments - lastComments) / 100) + 1);
        const lastPage = Math.ceil(issue.comments / 100);
        for (let page = firstPage; page <= lastPage; page += 1) {
          comments.push(...await call<RawComment[]>(
            `${base}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
          ));
        }
      }
      return {
        number: issue.number, title: issue.title, state: issue.state,
        labels: issue.labels.map((label) => label.name),
        createdAt: issue.created_at, closedAt: issue.closed_at,
        body: issue.body ?? '', stateReason: issue.state_reason,
        comments: lastComments > 0 ? comments.slice(-lastComments).map((comment) => ({
          body: comment.body ?? '', createdAt: comment.created_at,
        })) : [],
      };
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
    async addLabel(issueNumber, label) {
      await call(`${base}/issues/${issueNumber}/labels`, {
        method: 'POST',
        body: JSON.stringify({ labels: [label] }),
      });
    },
    async removeLabel(issueNumber, label) {
      // 404 when the label is already gone. The caller only removes a label it just
      // read as present, and reconciliation is per-issue try/catch, so a lost race
      // logs and self-corrects on the next run.
      await call(`${base}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`, {
        method: 'DELETE',
      });
    },
    async setIssueBody(issueNumber, body) {
      await call(`${base}/issues/${issueNumber}`, {
        method: 'PATCH',
        body: JSON.stringify({ body }),
      });
    },
  };
}
