import Anthropic from '@anthropic-ai/sdk';
import {
  ANALYSIS_TOOL_SCHEMA, AnalysisSchema, buildTriagePrompt,
  type Analysis, type TriageInput,
} from '../domain/triage-analysis';
import type { Env } from '../config/env';

export interface TriageLlm {
  /** Throws on transport error, missing/invalid structured output. */
  analyze(input: TriageInput): Promise<Analysis>;
}

const TOOL_NAME = 'submit_triage';
// 50 verdicts + up to 3 markdown issue bodies can plausibly exceed 8000 output
// tokens; 16000 still stays within non-streaming SDK timeout safety margins.
const MAX_TOKENS = 16000;

// Error messages below are budgeted for the daily digest, which shows only
// message.slice(0, 120) — lead with the diagnosis, keep quoted payloads short.

// Validate with a compact one-issue message instead of zod's pretty-printed
// multi-line JSON (which would spend the whole digest budget on braces).
function parseAnalysis(value: unknown): Analysis {
  const r = AnalysisSchema.safeParse(value);
  if (!r.success) {
    const issue = r.error.issues[0];
    const path = issue.path.join('.') || '(root)';
    throw new Error(`triage LLM: invalid response shape: ${path}: ${issue.message}`);
  }
  return r.data;
}

type AnthropicFactory = (apiKey: string) => Pick<Anthropic, 'messages'>;

export function createAnthropicTriageLlm(
  cfg: { apiKey: string; model: string },
  factory: AnthropicFactory = (apiKey) => new Anthropic({ apiKey }),
): TriageLlm {
  const client = factory(cfg.apiKey);
  return {
    async analyze(input) {
      const res = await client.messages.create({
        model: cfg.model,
        max_tokens: MAX_TOKENS,
        tools: [{
          name: TOOL_NAME,
          description: 'Submit the triage verdicts for all orphans.',
          // as never: ANALYSIS_TOOL_SCHEMA is `as const` (readonly arrays), but
          // the SDK's InputSchema type wants mutable string[] for `required`.
          input_schema: ANALYSIS_TOOL_SCHEMA as never,
          strict: true,
        }],
        tool_choice: { type: 'tool', name: TOOL_NAME },
        messages: [{ role: 'user', content: buildTriagePrompt(input) }],
      });
      // A truncated tool_use input is malformed by construction — report the
      // real cause instead of a downstream schema-validation error.
      if (res.stop_reason === 'max_tokens') {
        throw new Error('triage LLM: response truncated (max_tokens)');
      }
      const block = res.content.find((b) => b.type === 'tool_use');
      if (!block || block.type !== 'tool_use') {
        throw new Error(`triage LLM: no tool_use block in response (stop_reason=${res.stop_reason})`);
      }
      return parseAnalysis(block.input);
    },
  };
}

// Accepted asymmetry vs the Anthropic path: OpenAI JSON mode only guarantees
// syntactically valid JSON — the shape is prompt-driven, not schema-enforced
// (no strict tool-use equivalent here). parseAnalysis (zod) is the real gate.
export function createOpenAiTriageLlm(
  cfg: { apiKey: string; model: string; endpoint?: string; fetchImpl?: typeof fetch },
): TriageLlm {
  const endpoint = cfg.endpoint ?? 'https://api.openai.com/v1';
  const fetchImpl = cfg.fetchImpl ?? fetch;
  return {
    async analyze(input) {
      const res = await fetchImpl(`${endpoint}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: 'Respond with a single JSON object matching the requested shape: {"verdicts": [...], "new_issues": [...]}.' },
            { role: 'user', content: buildTriagePrompt(input) },
          ],
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(
          `triage LLM: OpenAI HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`,
        );
      }
      const data = await res.json() as { choices?: { message?: { content?: string } }[] };
      const content = data.choices?.[0]?.message?.content;
      // Endpoint is overridable — OpenAI-compatible gateways vary in shape.
      if (typeof content !== 'string') {
        throw new Error('triage LLM: OpenAI response has no choices');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        throw new Error(`triage LLM: response is not JSON: ${content.slice(0, 80)}`);
      }
      return parseAnalysis(parsed);
    },
  };
}

// null ⇒ triage disabled (missing key for the chosen provider); the job reports
// this in the digest rather than crashing startup.
export function createTriageLlm(env: Env): TriageLlm | null {
  if (env.TRIAGE_LLM_PROVIDER === 'openai') {
    return env.OPENAI_API_KEY
      ? createOpenAiTriageLlm({ apiKey: env.OPENAI_API_KEY, model: env.TRIAGE_LLM_MODEL })
      : null;
  }
  return env.ANTHROPIC_API_KEY
    ? createAnthropicTriageLlm({ apiKey: env.ANTHROPIC_API_KEY, model: env.TRIAGE_LLM_MODEL })
    : null;
}
