import { z } from 'zod';
import { callStructured, type OpenAiDeps } from './openai';
import { EMPTY_USAGE, addUsage, type Usage } from './usage';
import type { VerifyRequest, VerifyResult } from './types';

export type { VerifyRequest, VerifyResult } from './types';

/** Verdict budget scales with how many findings share the call. */
const TOKENS_PER_VERDICT = 1200;
const MIN_VERIFY_TOKENS = 2000;

export const VERDICTS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'verdict', 'evidence'],
        properties: {
          index: {
            type: 'integer',
            description: 'the 1-based number of the finding this verdict answers',
          },
          verdict: { type: 'string', enum: ['confirmed', 'refuted', 'out_of_scope'] },
          evidence: {
            type: 'string',
            description: 'one sentence citing the code that settles it',
          },
        },
      },
    },
  },
};

const verdictsSchema = z.object({
  verdicts: z.array(
    z.object({
      index: z.number().int(),
      verdict: z.enum(['confirmed', 'refuted', 'out_of_scope']),
      evidence: z.string(),
    }),
  ),
});

function renderFinding(r: VerifyRequest, index: number): string {
  return [
    `## Finding ${index}`,
    `Lines: ${r.matchedLine}-${r.matchedEndLine}`,
    `Claim: ${r.claim}`,
    `Alleged failure: ${r.why_it_breaks}`,
    '',
    'Quoted code:',
    '```',
    r.quote,
    '```',
  ].join('\n');
}

/**
 * Adjudicate every finding raised against one file, in one call.
 *
 * The file body is the expensive part of this prompt and it is identical for
 * every finding in the file, so sending it once instead of once per finding is
 * where most of the verify bill goes away. The model sees exactly the same
 * evidence and the same instructions it saw before; only the packaging changed.
 */
export async function verifyFile(
  deps: OpenAiDeps,
  p: { instructions: string; file: string; fileContent: string; requests: VerifyRequest[] },
): Promise<{
  verdicts: Map<number, { verdict: 'confirmed' | 'refuted' | 'out_of_scope'; evidence: string }>;
  usage: Usage;
  /** Set when the call completed but its content could not be used. */
  error?: string;
}> {
  const user = [
    `# ${p.requests.length} finding(s) to adjudicate in ${p.file}`,
    '',
    'Answer with one entry per finding, each carrying the finding number as `index`.',
    '',
    ...p.requests.map((r, i) => renderFinding(r, i + 1)),
    '',
    `# Full current contents of ${p.file}`,
    '```',
    p.fileContent,
    '```',
  ].join('\n');

  const { content, usage } = await callStructured(
    deps,
    [
      { role: 'system', content: p.instructions },
      { role: 'user', content: user },
    ],
    { name: 'review_verdicts', schema: VERDICTS_SCHEMA },
    Math.max(MIN_VERIFY_TOKENS, p.requests.length * TOKENS_PER_VERDICT),
  );

  // Unusable content is reported, not thrown: the call completed and is billed,
  // so its usage has to come back with the failure or the footer under-reports
  // money we actually spent. Only the findings in this file are affected.
  let parsed;
  try {
    parsed = verdictsSchema.safeParse(JSON.parse(content));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { verdicts: new Map(), usage, error: `Pass-2 output was not JSON: ${message.slice(0, 200)}` };
  }
  if (!parsed.success) {
    return {
      verdicts: new Map(),
      usage,
      error: `Pass-2 output did not match the schema: ${parsed.error.message.slice(0, 200)}`,
    };
  }

  const verdicts = new Map<number, { verdict: 'confirmed' | 'refuted' | 'out_of_scope'; evidence: string }>();
  for (const v of parsed.data.verdicts) {
    // An index nobody asked about is dropped rather than trusted: silently
    // shifting verdicts onto the wrong finding is worse than one `error`.
    if (v.index >= 1 && v.index <= p.requests.length) {
      verdicts.set(v.index, { verdict: v.verdict, evidence: v.evidence });
    }
  }
  return { verdicts, usage };
}

/**
 * Adjudicate every request, grouped into one call per file.
 *
 * Never throws: a failed call errors only the findings in that one file. The
 * caller decides what an `error` means — for a fresh finding it withholds it
 * (never publish an unchecked claim), for a re-check of an already-published
 * finding it keeps it open (never silently drop a claim the maintainer is
 * acting on). Results come back in request order.
 */
export async function verifyAll(
  deps: OpenAiDeps,
  p: {
    instructions: string;
    requests: VerifyRequest[];
    fileContent: (path: string) => string | null;
  },
): Promise<{ results: VerifyResult[]; usage: Usage }> {
  const byFile = new Map<string, VerifyRequest[]>();
  for (const r of p.requests) {
    const list = byFile.get(r.file);
    if (list) list.push(r);
    else byFile.set(r.file, [r]);
  }

  const byId = new Map<string, VerifyResult>();
  let usage = EMPTY_USAGE;

  for (const [file, requests] of byFile) {
    try {
      // Reading the file is inside the try as well: `fileContent` is a callback
      // we do not own, and "never throws" has to be a property of this function
      // rather than a promise we extract from every caller.
      const content = p.fileContent(file);
      if (content === null) {
        for (const r of requests) {
          byId.set(r.id, { id: r.id, verdict: 'error', evidence: 'file content unavailable' });
        }
        continue;
      }

      const out = await verifyFile(deps, {
        instructions: p.instructions,
        file,
        fileContent: content,
        requests,
      });
      usage = addUsage(usage, out.usage);
      requests.forEach((r, i) => {
        const v = out.verdicts.get(i + 1);
        byId.set(
          r.id,
          v
            ? { id: r.id, verdict: v.verdict, evidence: v.evidence }
            : {
                id: r.id,
                verdict: 'error',
                evidence: out.error ?? 'the verifier returned no verdict for this finding',
              },
        );
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const r of requests) {
        byId.set(r.id, { id: r.id, verdict: 'error', evidence: message.slice(0, 200) });
      }
    }
  }

  return { results: p.requests.map((r) => byId.get(r.id)!), usage };
}
