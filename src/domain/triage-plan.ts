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
  newIssues: PlannedNewIssue[];   // capped, labels forced, only keys actually referenced
  comments: PlannedComment[];     // grouped per existing issue
  quiet: Verdict[];               // not_on_untappd / wontfix — DB write only
  skipped: number;                // invalid verdicts left untriaged for tomorrow
}

export const MAX_NEW_ISSUES_PER_RUN = 3;

const classLabel: Record<string, string> = {
  parser_bug: 'parser-bug',
  matcher_bug: 'matcher-bug',
};

// Pure validation/routing of the LLM proposal. The LLM only proposes — this is
// where hallucinated issue numbers, ghost keys and issue spam get filtered.
// Skipped verdicts keep review_class NULL and re-enter tomorrow's selection.
export function planTriageActions(analysis: Analysis, openIssueNumbers: number[]): TriagePlan {
  const open = new Set(openIssueNumbers);
  const allowedKeys = new Set(
    analysis.new_issues.slice(0, MAX_NEW_ISSUES_PER_RUN).map((i) => i.key),
  );
  const byKey = new Map<string, Verdict[]>();
  const byIssue = new Map<number, Verdict[]>();
  const quiet: Verdict[] = [];
  let skipped = 0;

  for (const verdict of analysis.verdicts) {
    const actionable = verdict.review_class === 'parser_bug' || verdict.review_class === 'matcher_bug';
    if (!actionable) {
      quiet.push(verdict); // quiet classes never touch GitHub; stray refs are ignored
      continue;
    }
    const hasIssue = verdict.issue_number !== null;
    const hasKey = verdict.new_issue_key !== null;
    if (hasIssue === hasKey) { skipped++; continue; } // both or neither
    if (hasIssue) {
      if (!open.has(verdict.issue_number!)) { skipped++; continue; }
      const list = byIssue.get(verdict.issue_number!) ?? [];
      list.push(verdict);
      byIssue.set(verdict.issue_number!, list);
    } else {
      if (!allowedKeys.has(verdict.new_issue_key!)) { skipped++; continue; }
      const list = byKey.get(verdict.new_issue_key!) ?? [];
      list.push(verdict);
      byKey.set(verdict.new_issue_key!, list);
    }
  }

  const newIssues: PlannedNewIssue[] = analysis.new_issues
    .filter((i) => byKey.has(i.key))
    .map((i) => {
      const verdicts = byKey.get(i.key)!;
      const labels = ['orphan-triage', ...new Set(verdicts.map((x) => classLabel[x.review_class]))];
      return { key: i.key, title: i.title, body: i.body, labels, verdicts };
    });

  const comments: PlannedComment[] = [...byIssue.entries()]
    .map(([issueNumber, verdicts]) => ({ issueNumber, verdicts }));

  return { newIssues, comments, quiet, skipped };
}
