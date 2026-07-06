import type { Analysis, Verdict } from './triage-analysis';

export interface PlannedNewIssue {
  key: string;
  title: string;
  body: string;
  labels: string[];
  verdicts: Verdict[];
}

export interface PlannedComment {
  issueNumber: number;
  verdicts: Verdict[];
}

export interface TriagePlan {
  newIssues: PlannedNewIssue[];   // deduped + capped, labels forced, only keys actually referenced
  comments: PlannedComment[];     // grouped per existing issue
  quiet: Verdict[];               // not_on_untappd / wontfix — DB write only
  skipped: number;                // invalid verdicts left untriaged for tomorrow
}

export const MAX_NEW_ISSUES_PER_RUN = 3;

// Single source of truth for which classes go to GitHub and which label each
// maps to — the actionable check derives from these keys.
const CLASS_LABELS = {
  parser_bug: 'parser-bug',
  matcher_bug: 'matcher-bug',
} as const;

type ActionableClass = keyof typeof CLASS_LABELS;
type ActionableVerdict = Verdict & { review_class: ActionableClass };

const isActionable = (verdict: Verdict): verdict is ActionableVerdict =>
  verdict.review_class in CLASS_LABELS;

function pushInto<K>(map: Map<K, ActionableVerdict[]>, key: K, verdict: ActionableVerdict): void {
  const list = map.get(key);
  if (list) list.push(verdict);
  else map.set(key, [verdict]);
}

// Pure validation/routing of the LLM proposal. The LLM only proposes — this is
// where hallucinated issue numbers, ghost keys, duplicate keys and issue spam
// get filtered. Skipped verdicts keep review_class NULL and re-enter
// tomorrow's selection.
export function planTriageActions(analysis: Analysis, openIssueNumbers: number[]): TriagePlan {
  const open = new Set(openIssueNumbers);

  // Dedupe proposed issues by key (first occurrence wins) BEFORE applying the
  // cap, so duplicates neither spawn duplicate GitHub issues nor waste slots.
  const uniqueIssues = new Map<string, Analysis['new_issues'][number]>();
  for (const entry of analysis.new_issues) {
    if (!uniqueIssues.has(entry.key)) uniqueIssues.set(entry.key, entry);
  }
  const cappedIssues = [...uniqueIssues.values()].slice(0, MAX_NEW_ISSUES_PER_RUN);
  const allowedKeys = new Set(cappedIssues.map((i) => i.key));

  const byKey = new Map<string, ActionableVerdict[]>();
  const byIssue = new Map<number, ActionableVerdict[]>();
  const quiet: Verdict[] = [];
  let skipped = 0;

  for (const verdict of analysis.verdicts) {
    if (!isActionable(verdict)) {
      quiet.push(verdict); // quiet classes never touch GitHub; stray refs are ignored
      continue;
    }
    const hasIssue = verdict.issue_number !== null;
    const hasKey = verdict.new_issue_key !== null;
    if (hasIssue === hasKey) { skipped++; continue; } // both or neither
    if (hasIssue) {
      if (!open.has(verdict.issue_number!)) { skipped++; continue; }
      pushInto(byIssue, verdict.issue_number!, verdict);
    } else {
      if (!allowedKeys.has(verdict.new_issue_key!)) { skipped++; continue; }
      pushInto(byKey, verdict.new_issue_key!, verdict);
    }
  }

  const newIssues: PlannedNewIssue[] = cappedIssues
    .filter((i) => byKey.has(i.key))
    .map((i) => {
      const verdicts = byKey.get(i.key)!;
      const labels = ['orphan-triage', ...new Set(verdicts.map((x) => CLASS_LABELS[x.review_class]))];
      return { key: i.key, title: i.title, body: i.body, labels, verdicts };
    });

  const comments: PlannedComment[] = [...byIssue.entries()]
    .map(([issueNumber, verdicts]) => ({ issueNumber, verdicts }));

  return { newIssues, comments, quiet, skipped };
}
