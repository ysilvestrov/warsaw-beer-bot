import { expect, test, vi } from 'vitest';
import { createOpenAiTriageLlm, createAnthropicTriageLlm, createTriageLlm } from './triage-llm';
import { ANALYSIS_TOOL_SCHEMA, type TriageInput } from '../domain/triage-analysis';

const input: TriageInput = { orphans: [], openIssues: [] };
const validAnalysis = { verdicts: [], new_issues: [] };

test('openai: sends JSON-mode request, parses and validates content', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(validAnalysis) }, finish_reason: 'stop' }],
  }), { status: 200 }));
  const llm = createOpenAiTriageLlm({ apiKey: 'k', model: 'gpt-4o-mini', fetchImpl });
  const out = await llm.analyze(input);
  expect(out.analysis).toEqual(validAnalysis);
  expect(out.raw.provider).toBe('openai');
  expect(out.raw.stopReason).toBe('stop');
  expect(typeof out.raw.prompt).toBe('string');
  const [url, init] = fetchImpl.mock.calls[0];
  expect(String(url)).toBe('https://api.openai.com/v1/chat/completions');
  const body = JSON.parse(init.body as string);
  expect(body.model).toBe('gpt-4o-mini');
  expect(body.response_format).toEqual({ type: 'json_object' });
  expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k');
});

test('openai: schema-violating content throws a compact diagnosable message', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    choices: [{ message: { content: '{"verdicts": [{"beer_id": "oops"}]}' } }],
  }), { status: 200 }));
  const llm = createOpenAiTriageLlm({ apiKey: 'k', model: 'gpt-4o-mini', fetchImpl });
  await expect(llm.analyze(input)).rejects.toThrow(/invalid response shape/);
});

test('openai: non-JSON content names the problem and quotes a prefix', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    choices: [{ message: { content: 'Sorry, I cannot do that.' } }],
  }), { status: 200 }));
  const llm = createOpenAiTriageLlm({ apiKey: 'k', model: 'gpt-4o-mini', fetchImpl });
  await expect(llm.analyze(input)).rejects.toThrow(/not JSON.*Sorry, I cannot/);
});

test('openai: response without choices throws', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    error: { message: 'gateway shape' },
  }), { status: 200 }));
  const llm = createOpenAiTriageLlm({ apiKey: 'k', model: 'gpt-4o-mini', fetchImpl });
  await expect(llm.analyze(input)).rejects.toThrow(/no choices/);
});

test('openai: non-2xx throws with status and response body', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 }));
  const llm = createOpenAiTriageLlm({ apiKey: 'k', model: 'gpt-4o-mini', fetchImpl });
  await expect(llm.analyze(input)).rejects.toThrow(/429.*rate limited/);
});

test('anthropic: extracts tool_use input and validates', async () => {
  const create = vi.fn().mockResolvedValue({
    content: [{ type: 'tool_use', name: 'submit_triage', input: validAnalysis }],
    stop_reason: 'tool_use',
  });
  const llm = createAnthropicTriageLlm(
    { apiKey: 'k', model: 'claude-opus-4-8' },
    () => ({ messages: { create } }) as never,
  );
  const out = await llm.analyze(input);
  expect(out.analysis).toEqual(validAnalysis);
  expect(out.raw.provider).toBe('anthropic');
  expect(out.raw.stopReason).toBe('tool_use');
  const req = create.mock.calls[0][0];
  expect(req.tool_choice).toEqual({ type: 'tool', name: 'submit_triage' });
  expect(req.model).toBe('claude-opus-4-8');
  expect(req.tools[0].strict).toBe(true);
  expect(req.tools[0].input_schema).toBe(ANALYSIS_TOOL_SCHEMA);
});

test('anthropic: schema-violating tool input throws a compact diagnosable message', async () => {
  const create = vi.fn().mockResolvedValue({
    content: [{ type: 'tool_use', name: 'submit_triage', input: { verdicts: 'nope' } }],
    stop_reason: 'tool_use',
  });
  const llm = createAnthropicTriageLlm(
    { apiKey: 'k', model: 'claude-opus-4-8' },
    () => ({ messages: { create } }) as never,
  );
  await expect(llm.analyze(input)).rejects.toThrow(/invalid response shape/);
});

test('anthropic: missing tool_use block throws', async () => {
  const create = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'nope' }], stop_reason: 'end_turn' });
  const llm = createAnthropicTriageLlm(
    { apiKey: 'k', model: 'claude-opus-4-8' },
    () => ({ messages: { create } }) as never,
  );
  await expect(llm.analyze(input)).rejects.toThrow(/tool_use/);
});

test('anthropic: max_tokens stop_reason reports truncation, not a parse error', async () => {
  const create = vi.fn().mockResolvedValue({
    content: [{ type: 'tool_use', name: 'submit_triage', input: { verdicts: [] } }],
    stop_reason: 'max_tokens',
  });
  const llm = createAnthropicTriageLlm(
    { apiKey: 'k', model: 'claude-opus-4-8' },
    () => ({ messages: { create } }) as never,
  );
  await expect(llm.analyze(input)).rejects.toThrow(/truncated/);
});

test('factory: null when key for the chosen provider is missing', () => {
  const base = { TRIAGE_LLM_PROVIDER: 'anthropic', TRIAGE_LLM_MODEL: 'm' };
  expect(createTriageLlm({ ...base } as never)).toBeNull();
  expect(createTriageLlm({ ...base, ANTHROPIC_API_KEY: 'k' } as never)).not.toBeNull();
  expect(createTriageLlm({
    TRIAGE_LLM_PROVIDER: 'openai', TRIAGE_LLM_MODEL: 'm',
  } as never)).toBeNull();
  expect(createTriageLlm({
    TRIAGE_LLM_PROVIDER: 'openai', TRIAGE_LLM_MODEL: 'm', OPENAI_API_KEY: 'k',
  } as never)).not.toBeNull();
});
