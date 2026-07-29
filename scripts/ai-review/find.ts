import { z } from 'zod';
import { callStructured, type OpenAiDeps } from './openai';
import type { RawFinding } from './types';

export const FINDINGS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'file',
          'start_line',
          'end_line',
          'quote',
          'claim',
          'why_it_breaks',
          'severity',
          'confidence',
        ],
        properties: {
          file: { type: 'string', description: 'repo-relative path, exactly as shown' },
          start_line: { type: 'integer' },
          end_line: { type: 'integer' },
          quote: {
            type: 'string',
            description: 'verbatim copy of the offending code, exactly as it appears',
          },
          claim: { type: 'string', description: 'one sentence: what is wrong' },
          why_it_breaks: {
            type: 'string',
            description: 'concrete failure path: input or state -> wrong result',
          },
          severity: { type: 'string', enum: ['P0', 'P1', 'P2'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
  },
};

const findingSchema = z.object({
  file: z.string(),
  start_line: z.number().int(),
  end_line: z.number().int(),
  quote: z.string(),
  claim: z.string(),
  why_it_breaks: z.string(),
  severity: z.enum(['P0', 'P1', 'P2']),
  confidence: z.enum(['high', 'medium', 'low']),
});

const payloadSchema = z.object({ findings: z.array(findingSchema) });

export async function runFind(
  deps: OpenAiDeps,
  p: { instructions: string; context: string; prTitle: string; prBody: string },
): Promise<RawFinding[]> {
  const user = [
    '# Pull request',
    `Title: ${p.prTitle}`,
    '',
    '## Body',
    p.prBody || '(no description)',
    '',
    p.context,
  ].join('\n');

  const raw = await callStructured(
    deps,
    [
      { role: 'system', content: p.instructions },
      { role: 'user', content: user },
    ],
    { name: 'review_findings', schema: FINDINGS_SCHEMA },
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Pass-1 output could not be parsed as JSON: ${raw.slice(0, 300)}`);
  }

  const result = payloadSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Pass-1 output did not match the schema: ${result.error.message.slice(0, 300)}`);
  }
  return result.data.findings;
}
