/**
 * One draw of the verify corpus: every entry adjudicated by one model, scored
 * against the verdict we checked ourselves.
 *
 * Design: docs/superpowers/specs/2026-09/2026-09-23-verify-corpus-and-runner-design.md
 */
import { execFileSync } from 'node:child_process';
import type { OpenAiDeps } from './openai';
import { EMPTY_USAGE, addUsage, type Usage } from './usage';
import type { CorpusEntry } from './verify-corpus';
import type { verifyAll } from './verify';

export interface CorpusGroup {
  sha: string;
  file: string;
  entries: CorpusEntry[];
}

/**
 * Group by the PAIR `(sha, file)`, never by file alone.
 *
 * `verifyAll` batches one call per file path and its `fileContent` callback takes
 * only a path, so it cannot tell two shas apart. Handing it the whole corpus would
 * put the same path at two shas into one call against one body, and one of the two
 * answers would then be judged against code it was never about. The rule therefore
 * lives here, in the runner, and so does its test.
 */
export function groupEntries(entries: CorpusEntry[]): CorpusGroup[] {
  const groups = new Map<string, CorpusGroup>();
  for (const e of entries) {
    const key = `${e.sha}\u0000${e.file}`;
    const existing = groups.get(key);
    if (existing) existing.entries.push(e);
    else groups.set(key, { sha: e.sha, file: e.file, entries: [e] });
  }
  return [...groups.values()];
}

export interface EntryOutcome {
  id: string;
  expected: 'confirmed' | 'refuted';
  actual: 'confirmed' | 'refuted' | 'out_of_scope' | 'error';
  /** False for a wrong verdict AND for an `error`; read it with `actual`. */
  correct: boolean;
  evidence: string;
  provenance: 'harvested' | 'constructed';
}

/** Read one file body out of git at a pinned sha. Never throws. */
export function gitBody(sha: string, file: string): string | null {
  try {
    return execFileSync('git', ['show', `${sha}:${file}`], {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      // Absent paths are the expected, common failure here (an entry only exists
      // at the trees it was harvested from), and a paid corpus run should not
      // have `git`'s raw `fatal: …` interleaved with the judge's own output —
      // that noise is exactly the harness-vs-judge distinction this runner exists
      // to keep separate. The message still reaches the outcome via `evidence`.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

export async function runDraw(p: {
  entries: CorpusEntry[];
  instructions: string;
  readBody: (sha: string, file: string) => string | null;
  verify: typeof verifyAll;
  deps: OpenAiDeps;
  maxCompletionTokens?: number;
}): Promise<{ outcomes: EntryOutcome[]; usage: Usage }> {
  const byId = new Map<string, EntryOutcome>();
  let usage = EMPTY_USAGE;

  for (const group of groupEntries(p.entries)) {
    const body = p.readBody(group.sha, group.file);

    // An unreadable body is a harness failure, not a model failure, and it is
    // known before any call is made — so it is reported the same way an `error`
    // verdict is, without spending a call on a body the model can never see
    // correctly. `verify` is not invoked for this group at all.
    if (body === null) {
      for (const entry of group.entries) {
        byId.set(entry.id, {
          id: entry.id,
          expected: entry.expected,
          actual: 'error',
          correct: false,
          evidence: `file content unavailable for ${group.file} at ${group.sha}`,
          provenance: entry.provenance,
        });
      }
      continue;
    }

    const { results, usage: groupUsage } = await p.verify(p.deps, {
      instructions: p.instructions,
      requests: group.entries.map((e) => ({
        id: e.id,
        file: e.file,
        matchedLine: e.matchedLine,
        matchedEndLine: e.matchedEndLine,
        quote: e.quote,
        claim: e.claim,
        why_it_breaks: e.why_it_breaks,
      })),
      // Bound to THIS group's sha. `verifyAll` only ever asks for `group.file`
      // inside this call, so returning the same body for any path is correct here
      // and wrong anywhere else.
      fileContent: () => body,
      maxCompletionTokens: p.maxCompletionTokens,
    });
    usage = addUsage(usage, groupUsage);

    for (const entry of group.entries) {
      const result = results.find((r) => r.id === entry.id);
      const actual = (result?.verdict ?? 'error') as EntryOutcome['actual'];
      byId.set(entry.id, {
        id: entry.id,
        expected: entry.expected,
        actual,
        // `error` must never read as correct: it is a harness failure (#691),
        // not the model answering wrongly, but it is also not a match with the
        // expected verdict, so the plain equality already keeps it false.
        correct: actual === entry.expected,
        evidence: result?.evidence ?? '',
        provenance: entry.provenance,
      });
    }
  }

  return { outcomes: p.entries.map((e) => byId.get(e.id)!), usage };
}
