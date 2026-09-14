# #623 All-Adapter Non-Beer Badges — Periphery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the project specification, adapter-authoring contract, user guide, and release copy with the reviewed all-adapter non-beer badge behavior.

**Architecture:** Documentation records the already-reviewed core rather than defining new behavior. Engineering docs distinguish positive per-card classification from silent whole-page exclusion; user-facing copy describes only the visible red `✕` and its lack of interaction.

**Tech Stack:** OpenSpec Markdown, user-facing Markdown changelog and installation guide, npm/Vitest/Vite verification.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-13-623-all-adapters-nonbeer-badges-design.md`

## Global Constraints

- Start only after the core plan's whole-branch review passes.
- Describe `✕` as a confirmed shop classification, never as a missing match, missing rating, or network error.
- State that whole-page non-beer categories remain untouched.
- Keep changelog language user-facing; do not mention adapters, parsers, selectors, cache keys, or conformance tests.
- Do not publish to the Chrome Web Store.

---

### Task 1: Update the specification and adapter-authoring contract

**Files:**
- Modify: `spec.md`
- Modify: `docs/adapter-authoring.md`

**Interfaces:**
- Consumes: reviewed core behavior and the design's claim/evidence boundary.
- Produces: normative repository guidance for current and future adapters.

- [ ] **Step 1: Replace the silent per-card exclusion rule in `spec.md` §6**

Keep the existing classification vocabulary and false-positive guards verbatim, but change the outcome language to state:

```md
Кожен позитивний per-card non-beer сигнал повертає `Card.nonBeer + skip`: overlay
малює неклікабельний червоний `✕`, ставить `data-beerseen` і не читає/пише match-кеш,
не викликає `/match` та enrichment. Відсутня або неповна beer identity без позитивного
non-beer сигналу лишається тихим пропуском. `isNonBeerPage(url)` та еквівалентні
whole-page metadata gates лишають усю сторінку без overlay та без `✕`.
```

Update the flow paragraph so `nonBeer` is handled before cache-key construction for already-confirmed cards, while Flasker still captures normal-card keys before detail hydration.

- [ ] **Step 2: Rewrite adapter-authoring step 7 as the executable contract**

Replace the `parseCards → []` guidance with:

```md
Для позитивно визначеного окремого товару поверни
`{ el, brewery: '', name: '', nonBeer: true, skip: true }`; overlay поставить
неклікабельний червоний `✕` і не надішле товар до API. Не використовуй цей стан для
відсутньої назви, невдалого parse або network failure. `isNonBeerPage(url)` лишається
для категорій, де вся сторінка гарантовано не-пивна; такі сторінки overlay не змінює.
```

State that `<id>.nonbeer.html` normally must parse to one or more confirmed cards. Document the deliberate Beershop category-fixture exception and require a focused mixed-grid test whenever the fixture exercises a whole-page gate.

- [ ] **Step 3: Verify terminology and diff hygiene**

Run:

```bash
rg -n "parseCards.*\[\]|тільки не-пиво|nonBeer|isNonBeerPage|червоний" spec.md docs/adapter-authoring.md
git diff --check
```

Expected: no remaining normative statement says all per-card non-beers must parse as `[]`; whole-page silence remains explicit; `git diff --check` prints nothing.

- [ ] **Step 4: Commit engineering documentation**

```bash
git add spec.md docs/adapter-authoring.md
git commit -m "docs(extension): define explicit non-beer adapter output"
```

---

### Task 2: Update user-facing copy and run the release gate

**Files:**
- Modify: `docs/extension-install-uk.md`
- Modify: `extension/CHANGELOG.md`

**Interfaces:**
- Consumes: the reviewed and documented all-shop behavior.
- Produces: user-visible explanation and `[Unreleased]` release announcement copy.

- [ ] **Step 1: Generalize the install guide's token-free description**

Replace the Flasker-only paragraph with:

```md
Товари, які магазин однозначно позначає як не-пиво всередині змішаного каталогу,
отримують червоний `✕`; він не потребує токена й не є посиланням. Сторінки, повністю
присвячені мерчу, снекам або іншим не-пивним категоріям, розширення не змінює.
```

Change the badge-table row to:

```md
| <span style="color:#d32f2f">**✕**</span> | магазин однозначно класифікував товар у змішаному каталозі як **не пиво**; бейдж **не клікабельний** |
```

- [ ] **Step 2: Add one user-facing changelog entry under `[Unreleased]`**

Add exactly one bullet, without engineering vocabulary:

```md
- Products that a supported shop identifies as not beer now show a red, non-clickable `✕` when they appear alongside beer, instead of looking as if the extension missed them.
```

Do not add a line for tests, refactoring, cache ordering, or documentation.

- [ ] **Step 3: Run documentation checks and the full gate**

Run:

```bash
git diff --check
npm test
npm run typecheck
cd extension
npm test
npm run typecheck
npm run build
```

Expected:

- root: all tests PASS and typecheck exits 0;
- extension: all tests PASS, typecheck exits 0, production build exits 0;
- `git diff --check` prints nothing.

- [ ] **Step 4: Commit user-facing documentation**

```bash
git add docs/extension-install-uk.md extension/CHANGELOG.md
git commit -m "docs(extension): explain non-beer badges across shops"
```

- [ ] **Step 5: Verify final branch scope**

Run:

```bash
git status --short
git diff --stat origin/main...HEAD
git log --oneline origin/main..HEAD
```

Expected: clean working tree; commits cover only the approved design, plans, shared overlay, nine adapters and focused tests, conformance, specification, adapter guide, Ukrainian install guide, and extension changelog. No manifest, server, database, dependency, version, or release-store file changes appear.
