import { z } from 'zod';
import { callStructured, type OpenAiDeps } from './openai';
import type { GatedFinding, VerifiedFinding, Verdict } from './types';

export const VERDICT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'evidence'],
  properties: {
    verdict: { type: 'string', enum: ['confirmed', 'refuted', 'out_of_scope'] },
    evidence: {
      type: 'string',
      description: 'one sentence citing the code that settles it',
    },
  },
};

const verdictSchema = z.object({
  verdict: z.enum(['confirmed', 'refuted', 'out_of_scope']),
  evidence: z.string(),
});

export async function verifyFinding(
  deps: OpenAiDeps,
  p: { instructions: string; finding: GatedFinding; fileContent: string },
): Promise<{ verdict: Verdict; evidence: string }> {
  const user = [
    '# Finding to adjudicate',
    `File: ${p.finding.file}`,
    `Lines: ${p.finding.matchedLine}-${p.finding.matchedEndLine}`,
    `Claim: ${p.finding.claim}`,
    `Alleged failure: ${p.finding.why_it_breaks}`,
    '',
    'Quoted code:',
    '```',
    p.finding.quote,
    '```',
    '',
    `# Full current contents of ${p.finding.file}`,
    '```',
    p.fileContent,
    '```',
  ].join('\n');

  const raw = await callStructured(
    deps,
    [
      { role: 'system', content: p.instructions },
      { role: 'user', content: user },
    ],
    { name: 'review_verdict', schema: VERDICT_SCHEMA },
    2000,
  );

  const parsed = verdictSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`Pass-2 output did not match the schema: ${parsed.error.message.slice(0, 200)}`);
  }
  return parsed.data;
}

/**
 * Verifies every gated finding, one call each.
 *
 * Fails closed: a finding whose verification errors is withheld from the review
 * and reported in `rejected` with verdict `error`. A flaky verifier must never
 * turn a green PR red, and must never publish an unchecked claim either.
 */
export async function verifyAll(
  deps: OpenAiDeps,
  p: {
    instructions: string;
    findings: GatedFinding[];
    fileContent: (path: string) => string | null;
  },
): Promise<{ confirmed: VerifiedFinding[]; rejected: VerifiedFinding[] }> {
  const confirmed: VerifiedFinding[] = [];
  const rejected: VerifiedFinding[] = [];

  for (const finding of p.findings) {
    const content = p.fileContent(finding.file);
    if (content === null) {
      rejected.push({ finding, verdict: 'error', evidence: 'file content unavailable' });
      continue;
    }
    try {
      const { verdict, evidence } = await verifyFinding(deps, {
        instructions: p.instructions,
        finding,
        fileContent: content,
      });
      if (verdict === 'confirmed') confirmed.push({ finding, verdict, evidence });
      else rejected.push({ finding, verdict, evidence });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      rejected.push({ finding, verdict: 'error', evidence: message.slice(0, 200) });
    }
  }

  return { confirmed, rejected };
}
