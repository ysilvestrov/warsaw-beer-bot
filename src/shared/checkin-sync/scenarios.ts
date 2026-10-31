import type { CoverageRange } from './coverage';

// #924: one table of sync scenarios, run against the server route (SQLite) and the extension's
// local adapter (IndexedDB). Each scenario starts from an empty history and is a sequence of
// submitted pages; the expectations are written by hand from #587/#854, not derived from code.
// Data only: used by tests on both sides, never at runtime.

/** A feed page from ids (newest→oldest), with the selectors parseCheckinFeedPage reads. */
export function feedPageOf(ids: number[], opts: { total?: number; rating?: number | null } = {}): string {
  const stats = opts.total === undefined
    ? ''
    : `<div class="stats"><a><span class="stat">${opts.total}</span><span class="title">Total</span></a></div>`;
  const rating = opts.rating === undefined || opts.rating === null ? '' : `<div class="caps " data-rating="${opts.rating}"></div>`;
  const items = ids.map((id) => `
    <div class="item" data-checkin-id="${id}">
      <p class="text">
        <a href="/user/bob" class="user">Bob</a> is drinking an <a href="/b/ipa-${id}/${id}">Beer ${id}</a>
        by <a href="/SomeBrewery">Some Brewery</a>
      </p>
      ${rating}
      <a href="/user/bob/checkin/${id}" class="time timezoner">Mon, 15 Jun 2026 18:00:00 +0000</a>
    </div>`).join('');
  return `<html><body>${stats}${items}</body></html>`;
}

export const EMPTY_PAGE = '<html><body></body></html>';

export type StepExpect =
  | { status: 200; nextCursor: string | null; merged: number; alreadyKnown: number; serverCount: number }
  | { status: 400; error: 'bad_cursor' }
  | { status: 422; error: 'no_session' };

export interface SyncStep {
  html: string;
  maxId: string | null;
  expect: StepExpect;
}

export interface SyncScenario {
  name: string;
  steps: SyncStep[];
  /** Coverage after the last step, newest range first. */
  coverage: CoverageRange[];
}

const ok = (nextCursor: string | null, merged: number, alreadyKnown: number, serverCount: number): StepExpect =>
  ({ status: 200, nextCursor, merged, alreadyKnown, serverCount });

export const SYNC_SCENARIOS: SyncScenario[] = [
  {
    name: 'steps down from the profile page when nothing is covered yet',
    steps: [{ html: feedPageOf([600, 590, 580]), maxId: null, expect: ok('580', 3, 0, 3) }],
    coverage: [{ from_id: 580, to_id: 600 }],
  },
  {
    name: 'uses the request cursor as the upper bound of the proven range',
    steps: [
      { html: feedPageOf([600, 580]), maxId: null, expect: ok('580', 2, 0, 2) },
      { html: feedPageOf([570, 560]), maxId: '580', expect: ok('560', 2, 0, 4) },
    ],
    coverage: [{ from_id: 560, to_id: 600 }],
  },
  {
    name: 'jumps below covered territory instead of walking through it',
    steps: [
      { html: feedPageOf([500, 300, 100]), maxId: null, expect: ok('100', 3, 0, 3) },
      { html: feedPageOf([600, 550, 500]), maxId: null, expect: ok('100', 2, 1, 5) },
    ],
    coverage: [{ from_id: 100, to_id: 600 }],
  },
  {
    name: '#587: does not jump over a hole below the page, and closes it',
    steps: [
      { html: feedPageOf([200, 150, 100]), maxId: null, expect: ok('100', 3, 0, 3) },
      { html: feedPageOf([600, 590, 580]), maxId: null, expect: ok('580', 3, 0, 6) },
      { html: feedPageOf([300, 200]), maxId: '580', expect: ok('100', 1, 1, 7) },
    ],
    coverage: [{ from_id: 100, to_id: 600 }],
  },
  {
    name: 'stops the walk when the counts agree and coverage is one range',
    steps: [{ html: feedPageOf([600, 590, 580], { total: 3 }), maxId: null, expect: ok(null, 3, 0, 3) }],
    coverage: [{ from_id: 580, to_id: 600 }],
  },
  {
    name: 'a shrunk profile total does not stop the walk while coverage has a hole',
    steps: [
      { html: feedPageOf([600, 590]), maxId: null, expect: ok('590', 2, 0, 2) },
      { html: feedPageOf([300, 200]), maxId: null, expect: ok('200', 2, 0, 4) },
      { html: feedPageOf([600, 590], { total: 2 }), maxId: null, expect: ok('590', 0, 2, 4) },
    ],
    coverage: [{ from_id: 590, to_id: 600 }, { from_id: 200, to_id: 300 }],
  },
  {
    name: 'an empty page at or below the oldest known check-in ends the walk and claims nothing',
    steps: [
      { html: feedPageOf([600, 580]), maxId: null, expect: ok('580', 2, 0, 2) },
      { html: EMPTY_PAGE, maxId: '580', expect: ok(null, 0, 0, 2) },
    ],
    coverage: [{ from_id: 580, to_id: 600 }],
  },
  {
    name: '#587: an empty page above the oldest known check-in is a dead session',
    steps: [
      { html: feedPageOf([600, 580]), maxId: null, expect: ok('580', 2, 0, 2) },
      { html: EMPTY_PAGE, maxId: '900', expect: { status: 422, error: 'no_session' } },
    ],
    coverage: [{ from_id: 580, to_id: 600 }],
  },
  {
    name: 'an empty profile page is an empty account',
    steps: [{ html: EMPTY_PAGE, maxId: null, expect: ok(null, 0, 0, 0) }],
    coverage: [],
  },
  {
    name: '#587: a page whose oldest id is above the cursor is someone else\'s page',
    steps: [
      { html: feedPageOf([600, 580]), maxId: null, expect: ok('580', 2, 0, 2) },
      { html: feedPageOf([700, 650]), maxId: '580', expect: { status: 400, error: 'bad_cursor' } },
    ],
    coverage: [{ from_id: 580, to_id: 600 }],
  },
  {
    name: '#854: a fragment may not contain the cursor check-in itself',
    steps: [
      { html: feedPageOf([600, 580]), maxId: null, expect: ok('580', 2, 0, 2) },
      { html: feedPageOf([580, 570]), maxId: '580', expect: { status: 400, error: 'bad_cursor' } },
    ],
    coverage: [{ from_id: 580, to_id: 600 }],
  },
  {
    name: '#854: a backdated check-in above the cursor is a legitimate fragment',
    steps: [
      { html: feedPageOf([600, 580]), maxId: null, expect: ok('580', 2, 0, 2) },
      { html: feedPageOf([590, 560]), maxId: '580', expect: ok('560', 2, 0, 4) },
    ],
    coverage: [{ from_id: 560, to_id: 600 }],
  },
  {
    name: 'a non-numeric cursor is refused before anything is written',
    steps: [{ html: feedPageOf([600, 580]), maxId: '5e2', expect: { status: 400, error: 'bad_cursor' } }],
    coverage: [],
  },
  {
    name: 'a repeated page counts as already known',
    steps: [
      { html: feedPageOf([600, 580]), maxId: null, expect: ok('580', 2, 0, 2) },
      { html: feedPageOf([600, 580]), maxId: null, expect: ok('580', 0, 2, 2) },
    ],
    coverage: [{ from_id: 580, to_id: 600 }],
  },
];
