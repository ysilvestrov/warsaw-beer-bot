export class NonRetryableError extends Error {}

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export interface JsonSchemaFormat {
  name: string;
  schema: Record<string, unknown>;
}

export interface OpenAiDeps {
  endpoint: string;
  apiKey: string;
  model: string;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
}

export const DEFAULT_MAX_COMPLETION_TOKENS = 8000;

/**
 * One structured chat completion.
 *
 * Deliberately sends neither `temperature` nor `max_tokens`: the 2026-07-28 API
 * probe showed `max_tokens` is rejected with HTTP 400 on every gpt-5.x model,
 * and `temperature: 0` is rejected on gpt-5.5. Determinism comes from the
 * schema and the verification pass, not from sampling parameters.
 */
export async function callStructured(
  deps: OpenAiDeps,
  messages: ChatMessage[],
  format: JsonSchemaFormat,
  maxCompletionTokens: number = DEFAULT_MAX_COMPLETION_TOKENS,
): Promise<string> {
  const fetchFn = deps.fetchFn ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const attempts = deps.attempts ?? 3;
  const url = `${deps.endpoint.replace(/\/$/, '')}/chat/completions`;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${deps.apiKey}`,
        },
        body: JSON.stringify({
          model: deps.model,
          max_completion_tokens: maxCompletionTokens,
          response_format: {
            type: 'json_schema',
            json_schema: { name: format.name, strict: true, schema: format.schema },
          },
          messages,
        }),
      });

      if (res.status === 429 || res.status >= 500) {
        throw new Error(`OpenAI HTTP ${res.status}`);
      }
      if (!res.ok) {
        const text = await res.text();
        throw new NonRetryableError(`OpenAI HTTP ${res.status}: ${text.slice(0, 300)}`);
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new NonRetryableError('OpenAI returned an empty completion');
      return content;
    } catch (err) {
      if (err instanceof NonRetryableError) throw err;
      lastErr = err;
      if (attempt < attempts) await sleep(2 ** attempt * 100);
    }
  }
  throw new Error(`OpenAI request failed after ${attempts} attempts: ${String(lastErr)}`);
}
