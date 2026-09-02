# Popup: the no-token state leads with the action that works (#519, #522)

**Date:** 2026-09-01
**Issues:** #519 (in the no-token state the only useful actions are the weakest on screen), #522 (the popup hides the setup guide once a token exists)
**Ships in:** extension 0.16.0
**Model:** the popup's chrome is a pure function of one boolean (`hasToken`) applied to a fixed DOM — a view model plus a thin applier, the same shape as `clear-cache.ts`'s reducer plus injected effects.

## The problem, as measured in the code

A user who has just installed the extension has no token. In that state the
popup's amber primary button is `Sync my check-ins`, and clicking it does this
(`extension/src/popup/popup.ts:221`, `extension/src/background/index.ts:198-201`):

1. the popup calls `chrome.permissions.request({ origins: ['https://untappd.com/*'] })`
   — Chrome shows a host-permission prompt for a third-party site;
2. the background handler then reads the settings, finds no token, writes
   `outcome: 'error'` and returns;
3. the popup renders `Sync failed — check your connection and token, then retry.`

So the most prominent control walks a first-time user through a scary
permission dialog into a dead end, and the error it prints does not name the
actual cause. This is worse than #519 states, and it is the load-bearing
argument for the change: the fix is not cosmetic tiering, it removes a
permission prompt that can never lead anywhere.

Meanwhile `Get a token` and `Read the setup guide →` — the only two controls
that can move this user forward — are fifth and sixth in the DOM and rendered
in the quietest tiers.

The second half is #522: `guideLinkVisible(hasToken)` returns `true` only when
there is **no** token (`popup.ts:86-88`), so the setup guide is hidden from
every configured user — exactly the people who hit a sync error, a rate limit,
or a stale token. The options page shows the same link unconditionally.

## Decisions

### 1. Without a token, `Sync my check-ins` is disabled and says why

Demoted to `btn-secondary`, `disabled`, with `#syncStatus` reading
`Add a token to sync your check-ins.`

Rejected alternatives: leaving it enabled in a lower tier (the permission
prompt and the misleading error survive); making its click open the options
page (two controls with one action — `Get a token` already opens options).

The disabled-plus-caption pattern is not new here: `Refresh this page` on an
unsupported tab is already disabled with `Open a supported shop page to refresh
it.` in its own caption. The no-token popup reuses that vocabulary rather than
inventing one.

### 2. The auth block physically moves to the top, it is not just recoloured

`#authNote` and `#getToken` are wrapped in `<section id="authBlock">`, and in
the no-token state that section is inserted **immediately after
`<header class="head">`** — first among the actions, below the extension's own
title. Not `card.prepend`: that would put the note above the logo and name.

The block is only ever visible in the no-token state, so its position and its
visibility are one decision, not two.

Rejected: a class swap alone (the complaint in #519 is about order, and a
primary-tier button sitting fifth in the reading and Tab order still reads as
an afterthought); CSS `order` (visual order would disagree with focus order —
WCAG 2.4.3 — and 0.16.0 is the release that fixed the popup's accessibility,
not the one that reintroduces a defect there).

### 3. The guide link has one home per state

`guideLinkVisible` is **deleted**, not inverted. It is replaced by
`guideHome: 'auth' | 'foot'` — beside `Get a token` when there is no token,
in the footer when there is one. Visible in both.

Rejected: parking it permanently in the footer (that leaves a new user's
instructions as the quietest element on the card, which is the same defect
#519 is about); two `<a>` elements with the same `href` (they diverge at the
first copy edit).

### 4. Without a token the sync status is not polled

When there is no token the sync button gets no click handler and `poll()` never
runs.

This is a correctness requirement, not an optimization. `poll()` writes
`formatSyncStatus(s)` into `#syncStatus`, which would overwrite the caption
from decision 1 — with `''` for a fresh install, or, for anyone whose earlier
tokenless click stored `outcome: 'error'`, with
`Sync failed — check your connection and token, then retry.` A caption that
tells a new user their connection is broken is worse than no caption.

Review finding 5 (2026-09-01, whole-branch review): a run already in flight
when the token is cleared in options is not stopped by this decision. The
service worker keeps paging Untappd with the token it captured at start, but
the popup — gated on `hasToken` read at open time — shows the demoted,
disabled, captioned sync button with no `Stop` control, because `poll()`
never runs to surface the running state or offer a way to cancel it. No fix
is planned: the run is capped and self-terminating, and re-saving the token
restores both polling and `Stop` on the next popup open. Documented here as a
known, accepted gap rather than left silent.

### 5. What we are not doing (refuting part of #519 in place)

#519 proposes to "collapse the cache actions behind the fold or hide them until
configured". Rejected.

`Refresh this page` works without a token: the no-token overlay still shows
global Untappd ratings (⭐), and that is the entire value of the extension
before a token exists — `authNoteText` says so in as many words. Hiding the
control that produces it would hide the reason the user installed the thing.
`Clear all cache` is already in the footer, in the ghost tier, and since #517 it
is two-step, so it costs a new user nothing.

## Architecture

New file `extension/src/popup/token-state.ts` (`popup.ts` is already 243 lines;
this logic does not belong inside it):

```ts
export interface TokenStateView {
  authVisible: boolean;                      // shown, and placed right after <header class="head">
  syncTier: 'btn-primary' | 'btn-secondary';
  authTier: 'btn-primary' | 'btn-secondary';
  syncEnabled: boolean;
  syncCaption: string;                       // '' when the button is enabled
  guideHome: 'auth' | 'foot';
}

export interface TokenStateNodes {
  card: HTMLElement;
  header: HTMLElement;   // <header class="head">; the auth block is inserted after it
  authBlock: HTMLElement;
  syncBtn: HTMLButtonElement;
  syncStatus: HTMLElement;
  getTokenBtn: HTMLButtonElement;
  guideLink: HTMLAnchorElement;
  foot: HTMLElement;
}

export function tokenStateView(hasToken: boolean): TokenStateView;
export function applyTokenState(nodes: TokenStateNodes, view: TokenStateView): void;
```

| field | `hasToken: false` | `hasToken: true` |
| --- | --- | --- |
| `authVisible` | `true` | `false` |
| `syncTier` | `btn-secondary` | `btn-primary` |
| `authTier` | `btn-primary` | `btn-secondary` |
| `syncEnabled` | `false` | `true` |
| `syncCaption` | `Add a token to sync your check-ins.` | `''` |
| `guideHome` | `auth` | `foot` |

`applyTokenState` does not own the note's wording: `popup.ts` keeps writing
`authNoteText(hasToken)` into `#authNote` and keeps setting `guideLink.href`
and the `Get a token` click handler exactly as it does today. The view model
owns placement, tier, enabled-ness and the sync caption — nothing else.

`applyTokenState` is the only place that touches the DOM: it inserts
`#authBlock` after the header and shows it (or hides it), moves `#guideLink`
into its home and reveals it, swaps the two tier classes, and sets `disabled`
plus the caption. It never reads state back out of the DOM.

`popup.ts` keeps one call site, right where the current auth block is built:

```ts
const { token } = await getSettings();
const hasToken = Boolean(token);
applyTokenState(nodes, tokenStateView(hasToken));
```

and the sync wiring becomes conditional on `hasToken`.

## Markup

`popup.html`:

- `#authNote` and `#getToken` are wrapped in
  `<section id="authBlock" class="auth" style="display:none">`;
- `#guideLink` moves into `<footer class="foot">` in the markup, **before**
  `#clearAll` — the token-holding state is the common one, so that state needs
  no move at all, and putting help ahead of the destructive control keeps
  `Clear all cache` last in the footer's tab order. It keeps
  `style="display:none"`.

Both start hidden and are revealed by `applyTokenState` only after they are in
their final position, so the asynchronous init (`chrome.tabs.query`,
`getSettings`) cannot produce a visible jump. This is the same
hidden-then-revealed trick the auth block uses today.

`popup.css` gains only what the new wrapper needs. The separating rule moves
from the note to the wrapper: `.note` keeps its colour, size and
`margin: 0 0 8px` but gives up `padding-top: 12px` and
`border-top: 1px solid var(--hairline)`, which move to `.auth`. The block is
therefore still fenced off by one hairline, now drawn above the whole block
instead of above its first line. No new colour tokens — both tiers already
exist.

## Accessibility

The caption from decision 1 is written during init, before `armLiveRegions`
attaches `aria-live="polite"` (`popup.ts:238`). Opening the popup therefore
still announces nothing — the rule established by #524 stays intact — while a
later caption change (a click result) is announced once, beside its control.

Moving `#authBlock` to the front changes the reading and Tab order together
with the visual order, which is the point of decision 2: for a tokenless user
the first `Tab` lands on `Get a token`, not on a disabled sync button.

## Testing

`extension/src/popup/token-state.test.ts`

- `tokenStateView(false)` and `tokenStateView(true)` asserted field by field
  against the table above.
- `applyTokenState` on a jsdom fixture that mirrors `popup.html`:
  - no token → `#authBlock` is the element immediately after
    `<header class="head">` (not before it — the header stays first) and
    visible;
    `#guideLink` is a descendant of `#authBlock` and visible; `#syncCheckins`
    has `disabled === true` and class `btn-secondary`; `#getToken` has class
    `btn-primary`; `#syncStatus.textContent` is the caption.
  - token → `#authBlock` is hidden; `#guideLink` is a descendant of
    `<footer>` and visible; `#syncCheckins` is enabled with `btn-primary`;
    `#syncStatus` is empty.
  - applying the token view over the no-token view leaves no residue (classes,
    `disabled`, caption and link position all return to the token state) —
    the applier must be idempotent in either direction, since a future call
    site could re-apply it.

Every test is mutation-proven: deleting the line under test must turn it red
(project policy — vacuous tests have shipped here before).

The suite gate is the full one, per task: `npm test` in both `extension/` and
the repo root, plus `npm run typecheck`.

## Documentation in the same PR

- `spec.md` — two paragraphs are made false by this change and must move
  together: in **Auth / Popup керування кешем**, "після збереження токена ці
  три додаткові елементи ховаються" (the guide link no longer hides, and the
  three elements are no longer one group); in **Popup — ієрархія подання**, the
  fixed order "Sync → Refresh → Supported shops → Clear all cache" becomes
  state-dependent, and the claim that the primary action comes first must be
  restated as "the primary action for the current state comes first".
- `docs/extension-install-uk.md:243-244` — the same factual claim about the
  three elements disappearing, plus the no-token description of what the popup
  leads with (mandatory for any user-facing `extension/**` change, per
  CLAUDE.md).
- `extension/CHANGELOG.md` — entries under 0.16.0.

## Out of scope

- #521 (surfacing check-in counts or a "last synced" timestamp in the popup):
  `CheckinSyncState` carries no timestamp, so half of it needs new server-side
  data, and showing the count on open costs a network call per popup open. Its
  own cycle.
- Any change to `authNoteText`'s wording. It is accurate and it is what the
  moved block leads with; rewriting copy that no issue complains about is
  scope we did not ask for.
