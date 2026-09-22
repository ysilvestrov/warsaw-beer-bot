# Visible badge hover labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a mouse user read the same status description on hover that a screen reader receives for every extension badge.

**Architecture:** `renderState` already derives one `label` for every `CardState`. Pass it as the native `title` at the existing badge boundary, retaining `href` as the sole navigation control. Keep the user-facing contract and guides explicit about the uncertain-match example.

**Tech Stack:** TypeScript, Vitest, MV3 browser extension, Markdown.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-21-badge-hover-labels-design.md`

## Global Constraints

- Do not change matching, ratings, labels, or click destinations.
- A `title` must equal the existing `aria-label` for every badge state.
- Retain native browser tooltips; add no dependency or custom overlay.
- Update both install guides, `spec.md`, and the user-facing extension changelog.

---

### Task 1: Render the accessible status as a hover hint

**Files:**
- Modify: `extension/src/content/badge.ts:238-338`
- Test: `extension/src/content/badge.test.ts:111-231`

**Interfaces:**
- Consumes: `BadgeShape.label: string`, already passed by `renderState` for every `CardState`.
- Produces: each `[data-warsaw-beer-badge]` has `title` exactly equal to `aria-label`; `href` and `wireBadgeClicks` remain unchanged.

- [ ] **Step 1: Add failing assertions for the complete state table**

In the existing table-driven `#648 renderState` test, after the `aria-label` assertion, assert:

```ts
expect(badge.getAttribute('title')).toBe(wantLabel);
```

Update the passive-state test to expect `title` on `queued`, `working`, and `nonBeer`, and retain `cursor: 'default'` for non-links.

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npm --prefix extension test -- src/content/badge.test.ts
```

Expected: the new `title` assertions fail for normal and uncertain found states, because only `deferred` and `failed` currently set `title`.

- [ ] **Step 3: Set the title at the badge boundary**

In `buildBadge`, unconditionally set `title` from `shape.label`; remove `BadgeShape.title` and the per-state `title` assignments in `renderState`. Set `pointerEvents` to `auto` so even passive badges can receive a hover, and do not alter `wireBadgeClicks`.

- [ ] **Step 4: Run focused tests and the extension build**

Run:

```bash
npm --prefix extension test -- src/content/badge.test.ts
npm --prefix extension run build
```

Expected: all badge tests pass and the extension builds.

- [ ] **Step 5: Commit the tested behavior**

```bash
git add extension/src/content/badge.ts extension/src/content/badge.test.ts
git commit -m "fix(extension): show badge meanings on hover"
```

### Task 2: Publish the hover-label contract

**Files:**
- Modify: `spec.md:2851-2856`
- Modify: `docs/extension-install-uk.md:204-234`
- Modify: `docs/extension-install-en.md:204-237`
- Modify: `extension/CHANGELOG.md:26-34`

**Interfaces:**
- Consumes: Task 1's invariant that every badge title equals its `aria-label`.
- Produces: the specification, Ukrainian/English install guides, and public changelog all describe the same hover behavior.

- [ ] **Step 1: State the behavior without changing badge semantics**

Add to `spec.md` that every badge has `role="img"`, `aria-label`, and a native hover `title` with the same text. In both guides, say that hovering a badge shows its wording and retain the uncertain example `✅ ? ⭐ 3.6` as global—not personal—rating. Under `## [Unreleased]`, add one user-facing changelog line: hovering any badge now explains it in words.

- [ ] **Step 2: Render the public documentation**

Run:

```bash
npm run render-docs
git diff --check
```

Expected: renderer exits zero and the diff has no whitespace errors.

- [ ] **Step 3: Run the full gate**

Run:

```bash
npm test && npm run typecheck
```

Expected: the full suite and TypeScript checks pass.

- [ ] **Step 4: Commit the user-facing contract**

```bash
git add spec.md docs/extension-install-uk.md docs/extension-install-en.md extension/CHANGELOG.md
git commit -m "docs(extension): explain badge hover hints"
```

## Final verification

- [ ] Inspect `git diff origin/main...HEAD` for only the files named above.
- [ ] Fetch `origin/main`, rebase on it, then repeat `npm test && npm run typecheck` before opening the separate code PR.
