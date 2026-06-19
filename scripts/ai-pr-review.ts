export const INCLUDE_PATTERNS = [
  'src/**/*.ts',
  'tests/**/*.ts',
  'scripts/**/*.ts',
  'extension/**/*.ts',
  '.github/workflows/*.yml',
];

export const IGNORE_PATTERNS = ['package-lock.json', '*.md', 'docs/**'];

export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if ('.+?^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((p) => globToRegExp(p).test(path));
}

export function filterReviewableFiles(files: string[]): string[] {
  return files.filter(
    (f) => matchesAny(f, INCLUDE_PATTERNS) && !matchesAny(f, IGNORE_PATTERNS),
  );
}

export interface Config {
  openaiApiKey: string;
  openaiEndpoint: string;
  githubToken: string;
  repo: string;
  prNumber: number;
  baseRef: string;
  headRef: string;
  prTitle: string;
  prBody: string;
}

export function readConfig(env: NodeJS.ProcessEnv): Config {
  const required = (name: string): string => {
    const v = env[name];
    if (!v || v.trim() === '') throw new Error(`Missing required env: ${name}`);
    return v;
  };
  return {
    openaiApiKey: required('OPENAI_API_KEY'),
    openaiEndpoint: env.OPENAI_API_ENDPOINT?.trim() || 'https://api.openai.com/v1',
    githubToken: required('GITHUB_TOKEN'),
    repo: required('REPO'),
    prNumber: Number(required('PR_NUMBER')),
    baseRef: required('BASE_REF'),
    headRef: env.HEAD_REF?.trim() || '',
    prTitle: env.PR_TITLE ?? '',
    prBody: env.PR_BODY ?? '',
  };
}

export const DIFF_BUDGET = 100_000;

export function truncateDiff(diff: string, budget: number): { text: string; truncated: boolean } {
  if (diff.length <= budget) return { text: diff, truncated: false };
  return { text: diff.slice(0, budget), truncated: true };
}

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export function buildMessages(p: {
  instructions: string;
  prTitle: string;
  prBody: string;
  baseRef: string;
  headRef: string;
  diff: string;
  truncated: boolean;
}): ChatMessage[] {
  const user = [
    '# Pull request',
    `Title: ${p.prTitle}`,
    `Base: ${p.baseRef}`,
    `Head: ${p.headRef}`,
    '',
    '## Body',
    p.prBody || '(no description)',
    '',
    `## Diff${p.truncated ? ' (truncated — only the first part is shown)' : ''}`,
    '```diff',
    p.diff,
    '```',
  ].join('\n');
  return [
    { role: 'system', content: p.instructions },
    { role: 'user', content: user },
  ];
}

class NonRetryableError extends Error {}

export interface OpenAiDeps {
  endpoint: string;
  apiKey: string;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
}

export async function callOpenAI(deps: OpenAiDeps, messages: ChatMessage[]): Promise<string> {
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
          model: 'gpt-4o-mini',
          temperature: 0,
          top_p: 1,
          max_tokens: 10000,
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
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
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
