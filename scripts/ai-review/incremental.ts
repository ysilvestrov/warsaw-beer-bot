import { locateQuoteAll, pickMatch } from './gate';
import type { ReviewState, StoredFinding } from './state';

export type ReviewMode = 'full' | 'incremental' | 'republish';

export interface ModeDecision {
  mode: ReviewMode;
  /** What to pass to `git diff` / `git diff --name-only`. */
  diffSpec: string;
  /** One sentence for the ::notice line explaining why this mode. */
  reason: string;
}

/**
 * Which kind of review this run is.
 *
 * Every uncertain answer resolves to `full`: a full review is exactly today's
 * behaviour at today's price, so the worst case of a wrong guess here is that
 * we save nothing — never that we publish a review computed against a base that
 * is not really behind us.
 *
 * The predicates are injected rather than shelled out so the whole matrix is
 * testable without a git fixture.
 */
export function decideMode(p: {
  state: ReviewState | null;
  headSha: string;
  baseRef: string;
  hasCommit: (sha: string) => boolean;
  isAncestor: (ancestor: string, descendant: string) => boolean;
}): ModeDecision {
  const full = `origin/${p.baseRef}...HEAD`;

  if (!p.state) {
    return { mode: 'full', diffSpec: full, reason: 'no previous review state on this PR' };
  }
  const stored = p.state.head;

  if (!p.hasCommit(stored)) {
    return {
      mode: 'full',
      diffSpec: full,
      reason: `stored head ${stored} is not in this clone`,
    };
  }

  // Equality first: a commit is its own ancestor, so the ancestry branch would
  // otherwise classify a plain workflow re-run as an incremental review of an
  // empty diff — a full-price no-op.
  if (stored === p.headSha) {
    return { mode: 'republish', diffSpec: full, reason: 'HEAD unchanged since the last review' };
  }

  if (!p.isAncestor(stored, p.headSha)) {
    return {
      mode: 'full',
      diffSpec: full,
      reason: `stored head ${stored} is not an ancestor of HEAD (rebase or force-push)`,
    };
  }

  return {
    mode: 'incremental',
    diffSpec: `${stored}..HEAD`,
    reason: `incremental review of ${stored}..${p.headSha}`,
  };
}

export interface ClosedFinding {
  finding: StoredFinding;
  /** `obsolete` — the code it lived in is gone. `fixed` — a re-check retired it. */
  reason: 'obsolete' | 'fixed';
}

export interface Reconciliation {
  /** Still anchored in the file, line numbers refreshed. Costs nothing. */
  carried: StoredFinding[];
  /** The quoted code changed: worth one adjudication against the new body. */
  recheck: StoredFinding[];
  /** The file is gone; nothing left to adjudicate. */
  closed: ClosedFinding[];
}

/**
 * Sorts the previous run's published findings into carry / re-check / close by
 * re-anchoring each quote against the file as it is now.
 *
 * This is where the design pays for itself: a finding the push did not touch is
 * republished for zero API calls, and only a finding whose code actually moved
 * buys a call. Re-anchoring uses the gate's own matcher, so a re-indented or
 * re-wrapped quote still counts as unchanged.
 */
export function reconcileFindings(p: {
  stored: StoredFinding[];
  fileContent: (path: string) => string | null;
}): Reconciliation {
  const carried: StoredFinding[] = [];
  const recheck: StoredFinding[] = [];
  const closed: ClosedFinding[] = [];

  for (const finding of p.stored) {
    const content = p.fileContent(finding.file);
    if (content === null) {
      closed.push({ finding, reason: 'obsolete' });
      continue;
    }

    const matches = locateQuoteAll(content, finding.quote);
    if (matches.length === 0) {
      recheck.push(finding);
      continue;
    }

    // The same quote can occur several times; the finding is about the one it
    // was published against, so the stored line breaks the tie.
    const match = pickMatch(matches, finding.matchedLine);
    carried.push({ ...finding, matchedLine: match.start, matchedEndLine: match.end });
  }

  return { carried, recheck, closed };
}
