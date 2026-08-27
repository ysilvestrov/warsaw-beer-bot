import type { OwnerlessRow } from '../storage/enrich_failures';

export const MAX_INBOX_GROUPS = 10;
export const MAX_INBOX_ROWS_PER_GROUP = 15;

export interface InboxGroup { key: string; reason: string; rows: OwnerlessRow[]; }

// #509: the note is `off-scope <target>: <reason> | <the model's original
// review_note>` — the scope refusal is prepended to what the model said, not a
// replacement for it. The reason group is non-greedy and stops at the first
// ` | `, so the model's free-text tail (which itself may contain further text,
// even further ` | `-joined fragments from retireEnrichFailure) never leaks into
// the group's displayed reason. A note with no separator — the routing refused
// before any model note existed, or nothing follows the colon but `no scope
// block` — still matches whole: the optional tail is optional.
//
// #509 review round 2 (finding 2): the TARGET group is `.+?` (non-greedy, stops at the
// first `: `), not `\S+`. `new_issue_key` carries no whitespace restriction in the schema
// (z.string().min(1)), so a model-authored key like `cider brand line` used to fail this
// regex outright and fall through to UNRECOGNISED_KEY below. Measured across the
// archives: 23 model-authored keys, 0 with whitespace — never yet observed in production,
// but nothing in the schema prevents it, so it is fixed here rather than left as a known
// gap waiting to fire.
//
// `.` still deliberately excludes newlines (still NOT fixed, on purpose): a free-text
// `review_note` CAN contain one, and when it does, both `.`-based groups (target and
// reason) fail to span it, so the whole regex fails to match. Before this round that
// unparsed note was silently mislabelled as an absence note (see UNRECOGNISED_KEY below
// for why); it no longer is — an unparsed note now falls to UNRECOGNISED_KEY, which is
// honest about not having parsed it — but widening the regex to span newlines is a
// separate, narrower fix than the mislabelling this round of review addressed, and was
// deliberately left undone: measured, 0 model review_notes across the archives contain a
// newline.
//
// #509 review round 3: rounds 2 and 3-of-writing (above) both widened this regex to
// survive one more shape of model text, and each widening promptly failed on the next
// one — a `new_issue_key` containing `: ` still split in the wrong place, and a
// `contains` term's `value` containing ` | ` still truncated the reason. Both fields are
// model-authored and unconstrained by their zod schema, so no regex here can be made
// safe against them: there is always a string that reproduces whatever literal this
// pattern looks for. The fix landed at the WRITE site instead (triage-plan.ts's
// `sanitizeTarget`/`sanitizeReason`, called from `refuseRoute`), which strips `: ` and
// `|` out of the two fields before they are ever encoded into a note. This regex is
// therefore unchanged from round 2 and needs no further widening: its input is now
// guaranteed clean, not the pattern made cleverer.
const OFF_SCOPE = /^off-scope (.+?): (.*?)(?: \| .*)?$/;
// #509 fix round 3: `no absence evidence:` and `unverified:` are both prefixes THIS
// pipeline writes (triage-plan.ts's guard 3, and orphan-triage.ts's verification gate
// respectively) — matched by their own literal prefix, not "whatever OFF_SCOPE failed
// to parse". Keying the fallback off the regex miss instead of the note's real content
// is exactly the bug fixed below: it silently mislabelled anything unfamiliar as one of
// these two known shapes.
const ABSENCE_PREFIX = 'no absence evidence:';
const ABSENCE_KEY = 'absence not probed';
const UNVERIFIED_PREFIX = 'unverified:';
const UNVERIFIED_KEY = 'cause unverified';
// A note that matches none of the above is reported as what it is — unrecognised — not
// silently folded into "absence not probed". Before this fix that fold was a factual
// lie: a newline inside an off-scope note (review_note is free text and can contain
// one) makes OFF_SCOPE's `.` fail to match, and the row would land here labelled
// "absence was never probed" even though absence was never the claim at all.
const UNRECOGNISED_KEY = 'unrecognised';

// #509: the refused target IS the mechanism label. The model already said "these are
// ciders, they belong to #485"; the scope refused the routing, but the meaning survived,
// so grouping on it costs nothing and produces clusters a human can act on directly.
//
// Returns every group, UNSLICED — buildInboxBody does the MAX_INBOX_GROUPS cut, because
// it is also where the "N groups not shown" remainder line is rendered and the header's
// `groupable` figure is computed. Slicing here would let the two drift out of sync the
// same way `buildInboxBody`'s row-level cap and its own remainder line stay in sync only
// because they share one function.
export function groupOwnerless(rows: OwnerlessRow[]): InboxGroup[] {
  const by = new Map<string, InboxGroup>();
  for (const r of rows) {
    const note = r.review_note ?? '';
    const m = OFF_SCOPE.exec(note);
    let key: string;
    let reason: string;
    if (m) {
      key = m[1];
      reason = m[2];
    } else if (note.startsWith(ABSENCE_PREFIX)) {
      key = ABSENCE_KEY;
      reason = 'absence was never probed';
    } else if (note.startsWith(UNVERIFIED_PREFIX)) {
      key = UNVERIFIED_KEY;
      reason = "the model's proposed query did not reproduce the target";
    } else {
      key = UNRECOGNISED_KEY;
      reason = 'note format not recognised';
    }
    const g = by.get(key) ?? { key, reason, rows: [] };
    g.rows.push(r);
    by.set(key, g);
  }
  // Sorted by size: the biggest cluster is the most likely to be one real mechanism, and
  // whatever cap the caller applies has to drop something, so it should drop the smallest.
  return [...by.values()].sort((a, b) => b.rows.length - a.rows.length);
}

export function buildInboxBody(
  groups: InboxGroup[], totalOwnerless: number, dateKey: string,
): string {
  // #509 fix round 2: computed over ALL groups BEFORE the display cut below, not just the
  // ones rendered. groupOwnerless no longer slices to MAX_INBOX_GROUPS itself (that
  // decision moved here, next to the remainder line it has to stay honest with) — every
  // row in an 11th-and-beyond group is still machine-grouped and actionable, and folding
  // it into "free model prose, belongs to #508" was simply false.
  const groupable = groups.reduce((n, g) => n + g.rows.length, 0);
  const shown = groups.slice(0, MAX_INBOX_GROUPS);
  const droppedGroups = groups.length - shown.length;
  const droppedRows = groupable - shown.reduce((n, g) => n + g.rows.length, 0);
  const head = [
    `Оновлено автоматично: ${dateKey}. Не редагуй тіло — воно перезаписується щодня.`,
    '',
    // #509 fix round 1: this counts only matcher_bug/parser_bug — the two actionable
    // classes that ever carry an issue link in the first place. unidentifiable/
    // not_on_untappd are quiet by design and never own an issue, so they were never
    // candidates for "ownerless" and saying "з класом" without naming which classes
    // overstated what totalOwnerless actually measures.
    `Рядків matcher_bug/parser_bug без issue: **${totalOwnerless}** (з них ${groupable} з машинною причиною; `
    + `решта — вільні нотатки моделі, вони належать #508).`,
    '',
  ];
  const body = shown.flatMap((g) => {
    // Exactly two leading spaces before the beer id: the inbox is read by a human in a
    // browser, and the indent is what keeps a 15-row group scannable.
    const listed = g.rows.slice(0, MAX_INBOX_ROWS_PER_GROUP)
      .map((r) => `  ${r.beer_id} ${r.brewery} / ${r.name}`);
    const rest = g.rows.length - listed.length;
    return [
      `## ${g.key} — ${g.rows.length} рядків`,
      `причина відмови: ${g.reason}`,
      ...listed,
      ...(rest > 0 ? [`  ще ${rest}`] : []),
      '',
    ];
  });
  return [
    ...head, ...body,
    // #509 fix round 2: the group-level twin of the per-group `ще N` line above — a
    // group that fell off the MAX_INBOX_GROUPS cut is still real and still groupable, so
    // it gets counted here instead of vanishing into the header's #508 remainder.
    ...(droppedGroups > 0
      ? [`Ще ${droppedGroups} груп (${droppedRows} рядків) не показано — дивись у БД (enrich_failures).`, '']
      : []),
    'Закрий це issue, коли розгребеш — наступний ран заведе свіже з того, що лишилось.',
  ].join('\n');
}
