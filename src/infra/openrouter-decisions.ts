import type { IssueCandidate, IssueSelector } from '../domain/bug-report-types';
import { HttpStatusError } from '../domain/transient-error';

const NONE = 'None of the listed issues describes this same problem.';
const INSTRUCTIONS = 'Which existing GitHub issue describes the same defect as the user report? Titles are developer-facing and may use technical terms for the symptom the user describes.';

export function candidateCriteria(candidates: IssueCandidate[]): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const candidate of candidates) {
    const labels = candidate.labels.filter((label) =>
      !label.startsWith('Severity-') && !label.startsWith('effort/')).join(', ');
    criteria[`i${candidate.number}`] =
      `#${candidate.number} [${candidate.state}] ${labels} — ${candidate.title}`;
  }
  criteria.none = NONE;
  return criteria;
}

export function fitCandidates(
  candidates: IssueCandidate[], maxTokens = 28_000,
): { kept: IssueCandidate[]; truncated: boolean } {
  const kept = [...candidates];
  const estimatedTokens = (): number => Object.entries(candidateCriteria(kept))
    .reduce((chars, [key, value]) => chars + key.length + value.length, 0) / 2.5;
  while (kept.length > 0 && estimatedTokens() > maxTokens) {
    const closed = kept.filter((candidate) => candidate.state === 'closed')
      .sort((a, b) => (a.closedAt ?? '').localeCompare(b.closedAt ?? ''));
    const oldest = closed[0] ?? [...kept].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    kept.splice(kept.indexOf(oldest), 1);
  }
  return { kept, truncated: kept.length !== candidates.length };
}

export function createJevSelector(cfg: {
  apiKey: string; model: string; fetchImpl?: typeof fetch; maxTokens?: number;
}): IssueSelector {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  return {
    async select(input, candidates) {
      const { kept, truncated } = fitCandidates(candidates, cfg.maxTokens ?? 28_000);
      const criteria = candidateCriteria(kept);
      const response = await fetchImpl('https://openrouter.ai/api/alpha/decisions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model,
          state: { source: input.source, category: input.category, report: input.text },
          questions: { duplicate_of: { type: 'choice', instructions: INSTRUCTIONS, criteria } },
        }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new HttpStatusError(`Jev HTTP ${response.status}: ${body.slice(0, 300)}`, response.status);
      }
      const data = await response.json() as {
        answers?: { duplicate_of?: { probabilities?: Record<string, number> } };
      };
      const probabilities = data.answers?.duplicate_of?.probabilities;
      if (!probabilities || typeof probabilities !== 'object' || Array.isArray(probabilities)) {
        throw new Error('Jev response has no probabilities');
      }
      const numbers = Object.entries(probabilities)
        .sort(([aKey, a], [bKey, b]) => b - a || aKey.localeCompare(bKey))
        .slice(0, 5)
        .filter(([key]) => key !== 'none' && Object.hasOwn(criteria, key))
        .map(([key]) => Number(key.slice(1)));
      return { numbers, truncated };
    },
  };
}
