import { expect, test, vi } from 'vitest';
import type { IssueDetail, JudgeInput } from '../domain/bug-report-types';
import { InvalidVerdictOutputError } from '../domain/bug-report-types';
import { createOpenAiJudge, renderJudgeInput, VERDICT_SCHEMA, VERDICT_SYSTEM_PROMPT } from './bug-report-llm';
import { isTransient } from '../domain/transient-error';

const botInput: JudgeInput = {
  source: 'bot', category: 'route', text: 'Route misses a pub',
  latestExtensionVersion: null, candidates: [], images: [],
};
const validOutput = {
  verdict: 'new', issue_number: null, title: 'Маршрут пропускає паб',
  summary: 'Маршрут пропускає паб', where: 'Маршрут', subjects: ['Паб'],
  expected: 'Паб у маршруті', actual: 'Паб відсутній', steps: ['Побудувати маршрут'],
  screen_evidence: ['Паба не видно'], new_evidence: '', labels: ['bug'],
  severity: 'Severity-3', effort: 'effort/M', related: [12],
};

function response(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('renderJudgeInput gives a bot report an explicit empty candidate section', () => {
  expect(renderJudgeInput(botInput)).toBe(`USER REPORT
source: bot
category: route
text: Route misses a pub

CANDIDATE ISSUES
(none)`);
});

test('renderJudgeInput includes unknown extension version and a closed issue with truncated body and comments', () => {
  const issue: IssueDetail = {
    number: 88, title: 'Old badge defect', state: 'closed', labels: ['extension-bug', 'Severity-3'],
    createdAt: '2026-01-01T00:00:00Z', closedAt: '2026-02-03T00:00:00Z',
    stateReason: 'completed', body: 'B'.repeat(6001),
    comments: [
      { createdAt: '2026-02-01T08:00:00Z', body: 'First comment' },
      { createdAt: '2026-02-02T08:00:00Z', body: 'C'.repeat(1501) },
    ],
  };
  expect(renderJudgeInput({
    source: 'extension', category: 'no_badge', text: 'No white badge',
    latestExtensionVersion: null, candidates: [issue], images: [],
  })).toBe(`USER REPORT
source: extension
category: no_badge
latest published extension version: unknown
text: No white badge

CANDIDATE ISSUES
### #88 [closed, closed 2026-02-03, reason completed] Old badge defect
Labels: extension-bug, Severity-3

${'B'.repeat(6000)}

--- comment 2026-02-01:
First comment

--- comment 2026-02-02:
${'C'.repeat(1500)}`);
});

test('VERDICT_SCHEMA requires every snake-case field and forbids extras', () => {
  expect(VERDICT_SCHEMA.required).toEqual([
    'verdict', 'issue_number', 'title', 'summary', 'where', 'subjects', 'expected',
    'actual', 'steps', 'screen_evidence', 'new_evidence', 'labels', 'severity', 'effort', 'related',
  ]);
  expect(VERDICT_SCHEMA.additionalProperties).toBe(false);
  expect(VERDICT_SCHEMA.properties.issue_number).toEqual({ type: ['integer', 'null'] });
  expect(VERDICT_SCHEMA.properties.related).toEqual({ type: 'array', items: { type: 'integer' } });
});

test('judge sends strict schema and two image parts without unsupported request keys', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(response(200, {
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(validOutput) } }],
  }));
  const judge = createOpenAiJudge({ apiKey: 'key', model: 'gpt-test', endpoint: 'https://test.example/v1/',
    fetchImpl, maxCompletionTokens: 1234 });
  await judge.judge({ ...botInput, images: [
    { mime: 'image/png', base64: 'AAA' }, { mime: 'image/jpeg', base64: 'BBB' },
  ] });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const [url, init] = fetchImpl.mock.calls[0];
  expect(url).toBe('https://test.example/v1/chat/completions');
  expect(init.method).toBe('POST');
  expect(init.headers).toEqual({ Authorization: 'Bearer key', 'Content-Type': 'application/json' });
  expect(JSON.parse(init.body)).toEqual({
    model: 'gpt-test', max_completion_tokens: 1234,
    response_format: { type: 'json_schema', json_schema: {
      name: 'bug_report_verdict', strict: true, schema: VERDICT_SCHEMA,
    } },
    messages: [
      { role: 'system', content: VERDICT_SYSTEM_PROMPT },
      { role: 'user', content: [
        { type: 'text', text: `USER REPORT\nsource: bot\ncategory: route\ntext: Route misses a pub\n\nCANDIDATE ISSUES\n(none)` },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBB' } },
      ] },
    ],
  });
});

test('judge maps every snake-case field to RawVerdict camel case', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(response(200, {
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(validOutput) } }],
  }));
  const result = await createOpenAiJudge({ apiKey: 'key', model: 'gpt-test', fetchImpl }).judge(botInput);
  expect(result).toEqual({
    verdict: 'new', issueNumber: null, title: 'Маршрут пропускає паб',
    summary: 'Маршрут пропускає паб', where: 'Маршрут', subjects: ['Паб'],
    expected: 'Паб у маршруті', actual: 'Паб відсутній', steps: ['Побудувати маршрут'],
    screenEvidence: ['Паба не видно'], newEvidence: '', labels: ['bug'],
    severity: 'Severity-3', effort: 'effort/M', related: [12],
  });
});

test.each([
  ['missing content', { choices: [{ finish_reason: 'stop', message: {} }] }],
  ['length finish', { choices: [{ finish_reason: 'length', message: { content: JSON.stringify(validOutput) } }] }],
  ['invalid JSON', { choices: [{ finish_reason: 'stop', message: { content: '{' } }] }],
  ['missing required key', { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...validOutput, title: undefined }) } }] }],
  ['labels of the wrong type', { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...validOutput, labels: null }) } }] }],
  ['a non-string array item', { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...validOutput, steps: ['ok', 3] }) } }] }],
  ['a fractional issue number', { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...validOutput, issue_number: 1.5 }) } }] }],
  ['related of the wrong type', { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...validOutput, related: null }) } }] }],
  ['a fractional related number', { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...validOutput, related: [1.5] }) } }] }],
  ['a numeric title', { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...validOutput, title: 7 }) } }] }],
])('judge rejects %s as InvalidVerdictOutputError', async (_case, body) => {
  const fetchImpl = vi.fn().mockResolvedValue(response(200, body));
  const result = createOpenAiJudge({ apiKey: 'key', model: 'gpt-test', fetchImpl }).judge(botInput);
  await expect(result).rejects.toBeInstanceOf(InvalidVerdictOutputError);
});

test('the prompt defines related', () => {
  expect(VERDICT_SYSTEM_PROMPT).toContain('related: numbers of CANDIDATE ISSUES that are not the same defect');
});

test('judge reports HTTP 500 as HttpStatusError without retrying', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(response(500, { error: 'upstream' }));
  await expect(createOpenAiJudge({ apiKey: 'key', model: 'gpt-test', fetchImpl }).judge(botInput))
    .rejects.toMatchObject({ name: 'HttpStatusError', status: 500 });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

// Resolves only when the request's signal aborts, like a real fetch on a hung socket.
const hangingFetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
  init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
}));

test('the judge aborts a hung request after timeoutMs with a transient TimeoutError', async () => {
  const error = await createOpenAiJudge({ apiKey: 'k', model: 'm', fetchImpl: hangingFetch as never, timeoutMs: 20 })
    .judge({ source: 'bot', category: 'other', text: 'x', latestExtensionVersion: null, candidates: [], images: [] })
    .catch((e: unknown) => e);
  expect((error as Error).name).toBe('TimeoutError');
  expect(isTransient(error)).toBe(true);
});
