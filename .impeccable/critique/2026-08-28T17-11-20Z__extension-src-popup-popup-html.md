---
target: extension popup (Sync my check-ins / Clear all cache window)
total_score: 19
max_score: 40
na_heuristics: 
p0_count: 2
p1_count: 2
timestamp: 2026-08-28T17-11-20Z
slug: extension-src-popup-popup-html
---
Method: dual-agent (A: design review, isolated · B: detector + browser evidence, isolated)
Surface mode: **Operate** (the visitor completes a task).

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Live `Syncing… 1200 / 8200` + `poll()` on open is genuinely good, but it is a text log line; `clearAll` reports no count while `refresh` does. |
| 2 | Match System / Real World | 2 | "Clear all cache" / "Refresh this page" is implementation vocabulary; the user's words are badges, ratings, check-ins. |
| 3 | User Control and Freedom | 1 | `clearAll()` wipes all 9 shops with no confirm/undo/scope; a running sync has no stop — no `checkin-sync:stop` exists in the protocol. |
| 4 | Consistency and Standards | 1 | Popup and options look like different products; `.row` means column here and row there; `.status` is `1.2em` here and `20px` there. |
| 5 | Error Prevention | 1 | The destructive action is unconfirmed, second in the scan path, and visually identical to the benign one. |
| 6 | Recognition Rather Than Recall | 2 | The manifest knows 9 supported shops; the popup names zero. "Open a supported shop page" asks the user to recall which. |
| 7 | Flexibility and Efficiency | 2 | No accelerators, no focus on open; an 8200-check-in history needs manual re-presses, count never stated. |
| 8 | Aesthetic and Minimalist Design | 1 | Absence is not restraint. 7 declarations of CSS, one color, zero hierarchy, zero brand. |
| 9 | Error Recovery | 3 | Excellent cause+next-action copy on every branch, rendered in the identical `#444` 14px as success. |
| 10 | Help and Documentation | 3 | The guide link exists but `guideLinkVisible()` shows it only when there is no token — help vanishes exactly when sync errors begin. |
| **Total** | | **19/40** | **Below the typical 20–32 band** |

Heuristics 3/4/5/8 all score against the same single omission: there is no styled button system, so hierarchy, consistency, error prevention and aesthetics fail together. Fixing the button tiers plus confirmation lifts this to roughly 28.

## Design Specificity Verdict

**LLM assessment: category-interchangeable.** `popup.css` is 7 declarations over a UA form: one color (`#444`), zero backgrounds, zero borders, zero radii, zero brand. Delete the `<h1>` and this file is indistinguishable from a password manager's or a tab-suspender's popup.

That is damning specifically because the product already has a visual language the popup ignores:

| | badge overlay (`badge.ts:36-45`) | options (`options.css`) | popup |
|---|---|---|---|
| accent | — | `#d9822b` / hover `#c2741f` | none |
| surface | `rgba(20,20,20,0.82)` pill | `#fff` card on `#f6f6f7` | none (transparent) |
| radius | 6px | 12px card / 8px controls | 0 (UA native) |
| buttons | — | amber, #fff, 600, radius 8, hover | `padding: 8px` and nothing else |

`icon.svg` carries an amber→hop-green gradient (`#F8991D` → `#96CC39`). There is a brand one directory over, and a dark-pill badge vocabulary the user meets on every product card. The popup uses neither. Against the Raycast/Arc/native-macOS target: not close — that idiom is a tinted surface, one accent, tight rhythm, one unmistakable primary row.

**Deterministic scan: no usable coverage this run.** `detect.mjs` exited 0 with `[]` on both `popup.html` and `options.html`, but printed `DEGRADED - HTML parser modules unavailable (htmlparser2, css-select, css-tree, domutils)` and fell back to regex. Custom properties, selector matching and computed contrast were never evaluated. The empty result is an undercount, not a clean bill of health. (`css-tree` is absent from repo `node_modules` too, so full mode was not reachable without mutating repo state.)

**Browser evidence (measured, Chromium 1228, viewport 320×420):** all three buttons render at an identical **296×35** box. `.status` `#444` on white = **9.74:1**, button `#000` on `#efefef` = **18.26:1** — both pass AA; contrast is not a defect here. Buttons compute to **13.333px Arial**, not the 14px system-ui the body declares: form controls don't inherit, and `popup.css` never sets `font` on `button`. `button:disabled` differs from enabled by `opacity: 0.5` only in author CSS; box size is identical in both states (no layout shift).

## Overall Impression

The thinking in this popup is well above its appearance. `formatSyncStatus` is a pure, typed, unit-tested copy system where every branch names both cause and next action; the sync is resumable with the popup as a stateless view over it; the untappd.com permission is requested inside the click gesture with a comment explaining why. That is the hard part, and it is done.

What is missing is the entire visual layer, and its absence produces the single biggest problem: **the three buttons are indistinguishable, so the stated primary action is last and the irreversible one is second — directly under the cursor's descent from the toolbar icon.**

## What's Working

1. **The copy layer is a real design system.** Every `formatSyncStatus` branch gives cause and next action — `'Link your Untappd account in the bot first (/link).'`, `'Untappd is rate-limiting — try again later.'`, `'Sync interrupted — tap Sync to resume.'` No dead ends, no "An error occurred". Hardest thing to retrofit; already done.
2. **Resumable state with a stateless view.** `poll()` runs at init (`popup.ts:137`), not just on click, so reopening mid-run shows the live counter; `handleCheckinSyncStart` guards `alreadyRunning` on both an in-memory flag and stored status. Correct architecture for a long job in a surface dismissed by clicking anywhere.
3. **Consent bound to intent.** `chrome.permissions.request` fires on the Sync click as the first await so the gesture isn't consumed, with its own denial copy. The user is never asked for their Untappd session at install time.

## Priority Issues

### [P0] The primary CTA is indistinguishable from the destructive action
`button { padding: 8px; cursor: pointer }` is the entire button system; all three render as native grey at 296×35. Sync is last in DOM and scan path; `Clear all cache` is second.
**Why it matters:** the user opens this popup to sync, meets two cache buttons first, and the highest-affordance enabled control in the default state is the irreversible one. Misclick cost: every site's badges wiped, no undo.
**Fix:** kill the global `button` rule; author three tiers and put Sync first in the DOM. Primary amber filled (`#d9822b`, 600, radius 8, ~34px); secondary Refresh outlined (~30px); Clear all as a ghost footer item below a hairline (~26px, muted, 13px). Height encodes rank, color encodes intent.
**Suggested command:** `/impeccable layout`

### [P0] "Clear all cache" is irreversible, unconfirmed, unscoped and one click off the primary path
`clearAll()` removes every key under `PREFIX` across all 9 shops. `store.ts:33-37` has `ours.length` in hand and returns `Promise<void>`, so the user cannot even learn whether anything happened — while the *reversible* neighbour reports `Refreshed (3 cleared)`. The asymmetry is backwards.
**Fix:** in-place two-step, not a modal (a modal in a 264px popup is worse than the problem). First click relabels to `Clear cache for N sites?` for 3s in a danger tint; second executes and reports a count. Requires `clearAll(): Promise<number>`.
**Suggested command:** `/impeccable harden`

### [P1] Two typefaces, a fake 8px rhythm, and one real target-size failure
Buttons render **Arial 13.333px** while text renders system-ui 14px — the popup ships in two typefaces (`options.css:9` has the identical defect). Fix: `button, input { font: inherit }`.
Spacing scale is 8 / 8 / 8 / **12** / **10**; the `10px` on `.status` is on no grid at all. `.status { margin: 10px 0 0 }` has `margin-bottom: 0`, so `#getToken` sits flush against `#authNote` at 0px.
**On click targets:** measured ~296×35 (min card width is really **264px**, not 240 — `min-width: 240px` with no `box-sizing` reset applies to the content box). WCAG 2.5.5's 44×44 is **AAA and touch-derived** and is the wrong norm for a mouse-driven desktop toolbar popup; the governing floor is **SC 2.5.8 Target Size (Minimum), 24×24 CSS px, AA**, with the macOS/Raycast comfortable band at 28–32px. At 35px the buttons **already clear both — do not enlarge them.** The failure is uniformity, not size. The one genuine violation is `#guideLink`: an inline `<a>` at **19.6px** tall, under the 24px floor.
**Suggested command:** `/impeccable typeset`

### [P1] The shared `#status` element is orphaned and its message is destructible
`#status` is written by three unrelated handlers yet sits *between* the row it describes and the Sync row it never describes. Worse, the `clearAll` handler overwrites `'Open a supported shop page to refresh it.'` with `'Cache cleared.'` — the only account of why a control is dead is deleted by an unrelated click, and returns on next open, reading as a flicker bug.
**Fix:** move the disabled reason onto the button as a caption wired with `aria-describedby`; reserve `#status` for transient results; bind it to the row above with a tighter margin and a clear section gap below.
**Suggested command:** `/impeccable clarify`

### [P2] Disabled reads as "unrendered", and the destructive button is the first tab stop
`opacity: 0.5` on grey-on-white reads as half-painted, not unavailable. And because `#refresh` is `disabled` by default it leaves the tab order — **the first Tab lands on `#clearAll`**, the unconfirmed destructive action. There is **not one `:focus-visible` rule anywhere in `extension/src`** (verified).
**Fix:** give disabled its own tokens (flat fill, muted text, no shadow) rather than transparency; reorder so the primary is first (this also fixes tab order); add a real `:focus-visible` ring.
**Suggested command:** `/impeccable audit`

### [P2] Zero brand and no dark-mode ownership
One color in the file, and **no `color-scheme` and no `prefers-color-scheme` anywhere in the extension** (verified). In dark mode `#444` and the untouched UA chrome are unowned.
**Fix:** `color-scheme: light dark` plus ~8 tokens (`--bg --surface --fg --fg-muted --border --accent --accent-hover --danger`), ideally in a shared file imported by both `popup.css` and `options.css` so the surfaces stop drifting.
**Suggested command:** `/impeccable colorize`

## Persona Red Flags

**Sam (accessibility-dependent).** First focusable control is `#clearAll` — destructive, unconfirmed — because disabled `#refresh` drops out of the tab order. No `:focus-visible` anywhere in the extension. `#guideLink` is 19.6px, under SC 2.5.8. **Three `aria-live="polite"` regions fire in the same init tick**, so two unrelated announcements queue with nothing stating which control each belongs to. The disabled reason has no `aria-describedby` tie to `#refresh`. One `<h1>` and no `<h2>`: heading navigation yields exactly one stop.

**Jordan (first-timer, just installed, no token).** Meets **five controls and three text blocks** in a 264px box — a >4 decision point at the moment they know least. The two things they actually need (`#getToken`, `Read the setup guide →`) are last in the DOM, unstyled, jammed against `#authNote` at 0px gap, the link in plain UA blue. Two buttons say "cache", a word for a problem Jordan doesn't have. The brightest enabled thing in their path is `Clear all cache`, which they will click to "reset and try again".

**Riley (stress tester).** Clear-all: no confirm, no count. Permission denial, double-click Sync, and close-reopen mid-run are all genuinely handled. The break they find: if the `checkin-sync:start` callback never fires (service worker asleep, channel torn down), `poll()` is never called and the button **stays disabled on `'Starting…'` forever** — no timeout, no retry, no way out but reopening the popup.

**Marek (project persona: 34, Warsaw, browsing funkyshop.pl at 22:00 after a festival where he logged 30 beers).** His relationship with the product is the badge; he opens the popup twice a year, both times because something feels broken. His problem is "my new check-ins aren't showing on the cards" — the popup's words are *refresh*, *cache*, *cache*. On funkyshop.pl `#refresh` is enabled, sits first, and "refresh" is exactly the word his problem sounds like. He gets `Refreshed (0 cleared)` — true, reads as failure — and never learns new check-ins arrive via **Sync**. There is no "last synced" and no count, so the one question he came with (*is my history up to date?*) is unanswerable.

## Minor Observations

- Presentation logic is split three ways: inline `style="display:none"` in the HTML, `.style.display = ''` in the TS, and the CSS. Inline styles will beat any new rule — move to `hidden` / a class.
- `.row` means column in `popup.css`, row in `options.css`. `.status` is `min-height: 1.2em` vs `20px`. Shared names with divergent values look like a system and behave like drift.
- **The popup's width changes with which error you got:** `min-width` with no `max-width` and no `box-sizing` lets Chrome size to content, so the sync-failure string makes it wider than `'Cache cleared.'` Set an explicit width.
- `h1` at 15px on 14px body is a 1.07× bump costing ~23px of a ~200px canvas, on a surface already labelled by the toolbar icon.
- `Refreshed (0 cleared)` is true and reads as failure. `Nothing to refresh — badges are current.` states the same fact as success.
- The a11y bones are otherwise right and cheap to keep: `aria-live` on all three status regions, `type="button"` throughout, `rel="noopener"`, `lang="en"`.

## Questions to Consider

1. If the badge is the product and the popup is opened twice a year, why is the popup a control panel instead of a **status card** — `12,847 check-ins · last synced 3 days ago`, with the actions as small print underneath?
2. Who is "Clear all cache" actually for? If the honest answer is "me, when debugging", what breaks if it leaves the popup entirely for the options page?
3. Sync already knows `serverCount / profileTotal` and is resumable — so why is the user the loop? A scheduled background continuation converts the worst moment (press this 4 more times) into the best (it finished while you weren't looking).
4. If a user saw only this popup, could they name the product?
