import {
  AREA_LABELS, EFFORTS, InvalidVerdictOutputError, SEVERITIES, VERDICTS,
  type JudgeInput, type RawVerdict, type VerdictJudge,
} from '../domain/bug-report-types';
import { HttpStatusError } from '../domain/transient-error';

export const VERDICT_SYSTEM_PROMPT = `You process one user bug report for the Warsaw Beer Telegram bot and its browser extension.

Decide exactly one verdict:
- duplicate_open / duplicate_closed: the report describes the same defect (same symptom in the same
  place) as one of the CANDIDATE ISSUES. issue_number must be that candidate. Use the candidate's
  real state: duplicate_open for open, duplicate_closed for closed.
- new: a real defect that none of the candidates describes. issue_number null.
- not_a_bug: a question, a recommendation request, a feature wish, spam or abuse. issue_number null.
Judge by the full bodies, not by titles alone: titles often name the internal mechanism, the body
names the symptom.

Fill every text field in Ukrainian. Keep beer, brewery, pub and shop names, and text shown by our
product on screen, exactly as written.
Hard rules:
- Never include personal data: names, nicknames, Untappd usernames, e-mails, phone numbers, ids.
- Never quote the user's own words verbatim; describe them.
- Record the symptom only. Never guess the cause or the mechanism, not even in new_evidence.
- Leave a field empty ("" or []) when the report gives no data for it. Never invent steps.
- screen_evidence: only what the screenshots show that is relevant to the defect.
- new_evidence (duplicates only): what this report adds to the existing issue — another shop,
  another beer, "still reproduces". Empty for new and not_a_bug.

labels: the defect area — extension-bug (seen in the browser extension), matcher-bug (wrong beer or
missing rating although the beer exists on Untappd), parser-bug (wrong or non-beer data taken from a
pub or shop page), bug (anything else in the bot).
severity (1 = worst), judged only against a correct answer to the user and money:
- Severity-1: the main scenario is broken for everyone (no replies, empty or massively wrong
  recommendations).
- Severity-2: a WRONG answer for a class of beers or users (someone else's rating, "had" when not
  had, a tap linked to the wrong beer).
- Severity-3: a MISSING answer (beer without a rating, stale data, a failure with a workaround).
- Severity-4: cosmetics, wording, convenience.
effort: S = likely a small local fix, M = needs design, L = cause unclear. This is an estimate.
For not_a_bug, set severity Severity-4 and effort effort/S; they are ignored.`;

const textField = (limit: number) => ({ type: 'string', description: `At most ${limit} characters.` });
const stringItems = (count: number, limit: number) => ({
  type: 'array', items: { type: 'string' }, description: `At most ${count} items, ${limit} characters each.`,
});

export const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: [
    'verdict', 'issue_number', 'title', 'summary', 'where', 'subjects', 'expected',
    'actual', 'steps', 'screen_evidence', 'new_evidence', 'labels', 'severity', 'effort',
  ],
  properties: {
    verdict: { type: 'string', enum: VERDICTS },
    issue_number: { type: ['integer', 'null'] },
    title: textField(100), summary: textField(300), where: textField(200),
    subjects: stringItems(5, 100), expected: textField(200), actual: textField(200),
    steps: stringItems(5, 150), screen_evidence: stringItems(5, 150),
    new_evidence: textField(300),
    labels: { type: 'array', items: { type: 'string', enum: AREA_LABELS } },
    severity: { type: 'string', enum: SEVERITIES },
    effort: { type: 'string', enum: EFFORTS },
  },
};

export function renderJudgeInput(input: JudgeInput): string {
  const version = input.source === 'extension'
    ? `\nlatest published extension version: ${input.latestExtensionVersion ?? 'unknown'}` : '';
  const report = `USER REPORT
source: ${input.source}
category: ${input.category}${version}
text: ${input.text}`;
  const issues = input.candidates.map((issue) => {
    const state = issue.state === 'closed'
      ? `closed, closed ${issue.closedAt?.slice(0, 10) ?? 'unknown'}, reason ${issue.stateReason ?? 'unknown'}`
      : 'open';
    const comments = issue.comments.slice(-3).map((comment) =>
      `\n\n--- comment ${comment.createdAt.slice(0, 10)}:\n${comment.body.slice(0, 1500)}`).join('');
    return `### #${issue.number} [${state}] ${issue.title}
Labels: ${issue.labels.join(', ')}

${issue.body.slice(0, 6000)}${comments}`;
  }).join('\n\n');
  return `${report}\n\nCANDIDATE ISSUES\n${issues || '(none)'}`;
}

function parseVerdict(content: string): RawVerdict {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(content) as Record<string, unknown>;
  } catch {
    throw new InvalidVerdictOutputError('Invalid verdict JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)
    || VERDICT_SCHEMA.required.some((key) => !Object.hasOwn(raw, key))) {
    throw new InvalidVerdictOutputError('Missing verdict field');
  }
  return {
    verdict: raw.verdict, issueNumber: raw.issue_number,
    title: raw.title, summary: raw.summary, where: raw.where,
    subjects: raw.subjects, expected: raw.expected, actual: raw.actual,
    steps: raw.steps, screenEvidence: raw.screen_evidence,
    newEvidence: raw.new_evidence, labels: raw.labels,
    severity: raw.severity, effort: raw.effort,
  } as RawVerdict;
}

export function createOpenAiJudge(cfg: {
  apiKey: string; model: string; endpoint?: string; fetchImpl?: typeof fetch; maxCompletionTokens?: number;
}): VerdictJudge {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  return {
    async judge(input) {
      const url = `${(cfg.endpoint ?? 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`;
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model,
          max_completion_tokens: cfg.maxCompletionTokens ?? 8_000,
          response_format: { type: 'json_schema', json_schema: {
            name: 'bug_report_verdict', strict: true, schema: VERDICT_SCHEMA,
          } },
          messages: [
            { role: 'system', content: VERDICT_SYSTEM_PROMPT },
            { role: 'user', content: [
              { type: 'text', text: renderJudgeInput(input) },
              ...input.images.map((image) => ({
                type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.base64}` },
              })),
            ] },
          ],
        }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new HttpStatusError(`OpenAI HTTP ${response.status}: ${body.slice(0, 300)}`, response.status);
      }
      const data = await response.json() as {
        choices?: { finish_reason?: string; message?: { content?: string } }[];
      };
      const choice = data.choices?.[0];
      if (choice?.finish_reason === 'length') throw new InvalidVerdictOutputError('Verdict output was truncated');
      if (!choice?.message?.content) throw new InvalidVerdictOutputError('Verdict output is empty');
      return parseVerdict(choice.message.content);
    },
  };
}
