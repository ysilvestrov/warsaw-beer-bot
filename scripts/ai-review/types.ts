export type Severity = 'P0' | 'P1' | 'P2';
export type Confidence = 'high' | 'medium' | 'low';

/** A finding exactly as pass 1 emitted it. Line numbers are NOT trusted. */
export interface RawFinding {
  file: string;
  start_line: number;
  end_line: number;
  quote: string;
  claim: string;
  why_it_breaks: string;
  severity: Severity;
  confidence: Confidence;
}

/** A finding that survived the mechanical gate, with corrected line numbers. */
export interface GatedFinding extends RawFinding {
  /** 1-based line where `quote` actually starts in the HEAD file. */
  matchedLine: number;
  /** 1-based line where `quote` actually ends. */
  matchedEndLine: number;
}

export type DropReason =
  | 'out_of_scope'
  | 'quote_not_found'
  | 'outside_changed_lines'
  | 'duplicate';

export interface DroppedFinding {
  finding: RawFinding;
  reason: DropReason;
}

export interface GateResult {
  kept: GatedFinding[];
  dropped: DroppedFinding[];
}

export type Verdict = 'confirmed' | 'refuted' | 'out_of_scope' | 'error';

export interface VerifiedFinding {
  finding: GatedFinding;
  verdict: Verdict;
  evidence: string;
}
