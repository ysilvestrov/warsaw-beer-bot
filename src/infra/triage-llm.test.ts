import { expect, test, vi } from 'vitest';
import { createOpenAiTriageLlm, createAnthropicTriageLlm, createTriageLlm } from './triage-llm';
import type { TriageInput } from '../domain/triage-analysis';

const input: TriageInput = { orphans: [], openIssues: [] };
const validAnalysis = { verdicts: [], new_issues: [] };

test('openai: sends JSON-mode request, parses and validates content', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(validAnalysis) } }],
  }), { status: 200 }));
  const llm = createOpenAiTriageLlm({ apiKey: 'k', model: 'gpt-4o-mini', fetchImpl });
  const out = await llm.analyze(input);
  expect(out).toEqual(validAnalysis);
  const [url, init] = fetchImpl.mock.calls[0];
  expect(String(url)).toBe('https://api.openai.com/v1/chat/completions');
  const body = JSON.parse(init.body as string);
  expect(body.model).toBe('gpt-4o-mini');
  expect(body.response_format).toEqual({ type: 'json_object' });
  expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k');
});

test('openai: schema-violating content throws', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    choices: [{ message: { content: '{"verdicts": [{"beer_id": "oops"}]}' } }],
  }), { status: 200 }));
  const llm = createOpenAiTriageLlm({ apiKey: 'k', model: 'gpt-4o-mini', fetchImpl });
  await expect(llm.analyze(input)).rejects.toThrow();
});

test('openai: non-2xx throws with status', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 }));
  const llm = createOpenAiTriageLlm({ apiKey: 'k', model: 'gpt-4o-mini', fetchImpl });
  await expect(llm.analyze(input)).rejects.toThrow(/429/);
});

test('anthropic: extracts tool_use input and validates', async () => {
  const create = vi.fn().mockResolvedValue({
    content: [{ type: 'tool_use', name: 'submit_triage', input: validAnalysis }],
  });
  const llm = createAnthropicTriageLlm(
    { apiKey: 'k', model: 'claude-opus-4-8' },
    () => ({ messages: { create } }) as never,
  );
  const out = await llm.analyze(input);
  expect(out).toEqual(validAnalysis);
  expect(create.mock.calls[0][0].tool_choice).toEqual({ type: 'tool', name: 'submit_triage' });
  expect(create.mock.calls[0][0].model).toBe('claude-opus-4-8');
});

test('anthropic: missing tool_use block throws', async () => {
  const create = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'nope' }], stop_reason: 'end_turn' });
  const llm = createAnthropicTriageLlm(
    { apiKey: 'k', model: 'claude-opus-4-8' },
    () => ({ messages: { create } }) as never,
  );
  await expect(llm.analyze(input)).rejects.toThrow(/tool_use/);
});

test('factory: null when key for the chosen provider is missing', () => {
  const base = { TRIAGE_LLM_PROVIDER: 'anthropic', TRIAGE_LLM_MODEL: 'm' };
  expect(createTriageLlm({ ...base } as never)).toBeNull();
  expect(createTriageLlm({ ...base, ANTHROPIC_API_KEY: 'k' } as never)).not.toBeNull();
  expect(createTriageLlm({
    TRIAGE_LLM_PROVIDER: 'openai', TRIAGE_LLM_MODEL: 'm', OPENAI_API_KEY: 'k',
  } as never)).not.toBeNull();
});
