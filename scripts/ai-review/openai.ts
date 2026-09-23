import { parseUsage, type Usage } from './usage';

/**
 * A failure that must not be retried.
 *
 * `usage` is set when the call **completed and was billed** but its content was
 * unusable — the empty-completion case below. Carrying it is not tidiness: the
 * spec's rule for the cost footer is that the reviewer prints its own bill and
 * that an admitted gap beats an invented number, and a billed call that vanishes
 * from the footer understates the bill *silently*, which is the one direction
 * that rule exists to forbid. Callers that swallow this error to keep going
 * (`verifyAll`) must add `usage` to their running total. It stays undefined for
 * transport and HTTP failures, where no token count was ever reported.
 */
export class NonRetryableError extends Error {
  readonly usage?: Usage;

  constructor(message: string, usage?: Usage) {
    super(message);
    this.usage = usage;
  }
}

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
 * One structured chat completion, with the tokens it cost.
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
): Promise<{ content: string; usage: Usage }> {
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
        // Carry the body into the error. OpenAI returns an exhausted balance as
        // 429 `insufficient_quota`, which is NOT a throttle — retrying it three
        // times and reporting "failed after 3 attempts" hides the real cause
        // from whoever debugs the red check.
        const text = await res.text().catch(() => '');
        if (text.includes('insufficient_quota')) {
          throw new NonRetryableError(
            `OpenAI HTTP ${res.status}: quota exhausted for this API key — ${text.slice(0, 200)}`,
          );
        }
        throw new Error(`OpenAI HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      if (!res.ok) {
        const text = await res.text();
        throw new NonRetryableError(`OpenAI HTTP ${res.status}: ${text.slice(0, 300)}`);
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: unknown;
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        // Measured in production 2026-09-23 (#691): a reasoning model can spend the
        // whole `max_completion_tokens` budget thinking and emit no content. The call
        // is billed for every one of those tokens, so the usage travels with the
        // failure.
        throw new NonRetryableError('OpenAI returned an empty completion', parseUsage(data.usage));
      }
      // Usage is read from the same response as the content, so a call can never
      // be published without being billed for in the footer.
      return { content, usage: parseUsage(data.usage) };
    } catch (err) {
      if (err instanceof NonRetryableError) throw err;
      lastErr = err;
      if (attempt < attempts) await sleep(2 ** attempt * 100);
    }
  }
  throw new Error(`OpenAI request failed after ${attempts} attempts: ${String(lastErr)}`);
}
