import {
  AREA_LABELS, EFFORTS, SEVERITIES, USER_REPORT_LABEL, VERDICTS,
  type AreaLabel, type IssueDetail, type RawVerdict, type ReportSource, type ValidationResult,
} from './bug-report-types';
import { redactFields } from './bug-report-redact';
import { clampFields } from './bug-report-template';

// Related issues are hints: discard invalid entries without re-judging the verdict.
function relatedIssues(raw: RawVerdict, candidates: IssueDetail[]): number[] {
  const shown = new Set(candidates.map((candidate) => candidate.number));
  const result: number[] = [];
  for (const number of raw.related) {
    if (shown.has(number) && number !== raw.issueNumber && !result.includes(number)) result.push(number);
  }
  return result.slice(0, 3);
}

export function validateVerdict(
  raw: RawVerdict, candidates: IssueDetail[], source: ReportSource,
): ValidationResult {
  if (!VERDICTS.includes(raw.verdict)) return { ok: false, reason: 'Unknown verdict.' };

  const duplicate = raw.verdict === 'duplicate_open' || raw.verdict === 'duplicate_closed';
  if ((raw.issueNumber !== null) !== duplicate) {
    return { ok: false, reason: 'Issue number must match duplicate verdict.' };
  }

  const issue = duplicate ? candidates.find((candidate) => candidate.number === raw.issueNumber) : undefined;
  if (duplicate && !issue) return { ok: false, reason: 'Issue number is not a candidate.' };
  if (duplicate && issue?.state !== (raw.verdict === 'duplicate_open' ? 'open' : 'closed')) {
    return { ok: false, reason: 'Candidate state does not match duplicate verdict.' };
  }

  if (raw.verdict === 'not_a_bug') return { ok: true, value: { kind: 'not_a_bug' } };

  // Redact BEFORE clamping: a cut can split an e-mail or phone at the limit into a fragment the
  // patterns no longer recognise, and that fragment would be published.
  const fields = clampFields(redactFields(raw));
  if (raw.verdict === 'new') {
    if (!SEVERITIES.includes(raw.severity)) return { ok: false, reason: 'Invalid severity.' };
    if (!EFFORTS.includes(raw.effort)) return { ok: false, reason: 'Invalid effort.' };
    if (!fields.title) return { ok: false, reason: 'New issue title is empty.' };

    const selected = new Set(raw.labels.filter((label): label is AreaLabel =>
      AREA_LABELS.some((area) => area === label)));
    if (source === 'extension') selected.add('extension-bug');
    if (selected.size === 0) selected.add('bug');
    const labels = [...AREA_LABELS.filter((label) => selected.has(label)), USER_REPORT_LABEL];
    return { ok: true, value: { kind: 'new', fields, labels, severity: raw.severity, effort: raw.effort, related: relatedIssues(raw, candidates) } };
  }

  return { ok: true, value: { kind: raw.verdict, issue: issue!, fields, related: relatedIssues(raw, candidates) } };
}
