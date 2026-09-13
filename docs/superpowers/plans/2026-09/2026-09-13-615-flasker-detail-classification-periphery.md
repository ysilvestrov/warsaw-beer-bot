# Flasker Detail Classification Periphery Implementation Plan

> **For implementation:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task in the main thread. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the canonical specification and Ukrainian user-facing documentation with the reviewed #615 Flasker classification core.

**Architecture:** This is a documentation-only follow-up to the reviewed core commits. It replaces the obsolete Flasker volume/cap/cache claims, documents the Flasker-only non-beer state, and explains the visible red `✕` without broadening behavior to other adapters.

**Tech Stack:** OpenSpec Markdown, extension changelog Markdown, Ukrainian installation guide Markdown.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-13-615-flasker-detail-classification-design.md`

## Global Constraints

- Scope is Flasker only; #623 owns other adapters.
- Preserve the existing distinction between eligible cider/mead/kvass/kombucha and non-beer merchandise.
- The red `✕` means only a successful Flasker product-category classification as non-beer.
- The red `✕` is not clickable; existing beer-result badges remain clickable.
- Write changelog copy for extension users, not in parser/cache terminology.
- Do not modify code, dependencies, manifests, APIs, database behavior or release state.

---

### Task 1: Update the canonical extension contract

**Files:**
- Modify: `spec.md:2437-2598`

**Interfaces:**
- Consumes: reviewed `Card.nonBeer`, `SiteAdapter.loadDetailsBeforeCache`, Flasker product-category hydration and badge behavior.
- Produces: the canonical behavior contract used by future adapter, overlay and badge changes.

- [ ] **Step 1: Replace the obsolete Flasker volume/detail paragraph**

State all of the following in the existing Flasker adapter entry:

```markdown
  volume або ABV задає межу brewery/name; картки без обох маркерів лишаються
  classification-only (`skip`) і не потрапляють у matching. Для **всіх** Flasker-карток
  із product URL сторінка товару завантажується до читання match-кешу, без ліміту 20,
  з дедуплікацією за URL. WooCommerce category читається тільки з
  `.posted_in a[href*="/product-category/"]`, щоб brand-посилання не стало category.
  Non-beer category ставить confirmed `nonBeer`; parsed provisional картка допускається
  далі лише після успішної відповіді з usable category без non-beer veto. Fetch failure
  лишає established beer fail-open, а provisional/classification-only — fail-closed.
  Початковий listing key фіксується до hydration і лишається ключем cache read/write.
```

Keep the existing brewery, published-bid and imported-placeholder rules intact.

- [ ] **Step 2: Update overlay, conformance and badge statements**

Make these precise edits in their current paragraphs:

```markdown
- Потік: Flasker opt-in hydration/classification happens before cache; every other adapter retains cache-first, miss-only detail hydration.
- Conformance: Flasker is the temporary #615 exception that emits provisional non-beer fixture cards, hydrates them, and requires `nonBeer`; other adapters still require `parseCards(...) === []`. #623 owns convergence.
- Badges: add Flasker-only red `✕` for category-confirmed non-beer; no click/focus/action. Replace “Усі бейджі клікабельні” with “Бейджі результатів пива ... клікабельні”.
```

- [ ] **Step 3: Verify the specification diff**

Run from the repository root:

```bash
git diff --check -- spec.md
rg -n "loadDetailsBeforeCache|product-category|nonBeer|✕|#623|20" spec.md
```

Expected: no whitespace errors; the new Flasker and badge contract is findable, and the removed 20-card claim is absent from the Flasker entry.

---

### Task 2: Explain the visible change to extension users

**Files:**
- Modify: `extension/CHANGELOG.md:20-24`
- Modify: `docs/extension-install-uk.md:22-31,174-229`

**Interfaces:**
- Consumes: the canonical behavior written in Task 1.
- Produces: release-announcement copy and the Ukrainian badge/detail-loading guide.

- [ ] **Step 1: Add one user-facing changelog entry**

Insert this as the first bullet under `## [Unreleased]`:

```markdown
- Fixed six Flasker beers without a package volume showing no badge. They now get their normal rating/status badge, while Flasker merchandise is marked with a non-clickable red ✕ instead of looking like an unrated beer or receiving a misleading beer badge.
```

- [ ] **Step 2: Update the no-token and Flasker detail explanation**

In `Що видно без токена`, add that Flasker's category-confirmed merchandise shows a red `✕` without a token. In the Flasker note under Part 3, replace `до 20` with all visible product cards and explain that the same product-page request reads category, brewery and the published Untappd link; category-confirmed merchandise is excluded from beer matching.

Use this user-facing wording for the new statements:

```markdown
На Flasker товари, які сам магазин відносить до категорії не-пива, також отримують
червоний `✕`; він не потребує токена й не є посиланням.

На сторінках `flasker.com.ua` розширення і без цього дозволу автоматично завантажує
у фоні сторінки всіх видимих товарів. Звідти воно читає категорію товару, броварню
та опубліковане магазином посилання на Untappd. Так пиво без указаного об'єму не
губиться, а підтверджені магазином келихи, сувеніри та інші товари не надсилаються
на звірку як пиво й отримують червоний `✕`.
```

- [ ] **Step 3: Extend the badge legend**

Add this row before the `_(без бейджа)_` row:

```markdown
| <span style="color:#d32f2f">**✕**</span> | лише на Flasker: магазин відніс товар до категорії **не-пива**; бейдж **не клікабельний** |
```

Keep the existing meanings and click behavior of ✅, ❓, ⭐, ⚪ and ⏳ unchanged.

- [ ] **Step 4: Verify user-facing copy and commit**

Run:

```bash
git diff --check -- extension/CHANGELOG.md docs/extension-install-uk.md
rg -n "six Flasker beers|червоний.*✕|не клікабельний|всіх видимих товарів" extension/CHANGELOG.md docs/extension-install-uk.md
```

Expected: all four phrases are present in their intended documents, with one changelog bullet for #615.

Commit all periphery files together because they describe one already-reviewed behavior:

```bash
git add spec.md extension/CHANGELOG.md docs/extension-install-uk.md docs/superpowers/plans/2026-09/2026-09-13-615-flasker-detail-classification-periphery.md
git commit -m "docs(extension): explain Flasker product classification"
```

---

## Verification

After the documentation commit:

```bash
git diff --check origin/main...HEAD
git status --short
```

Expected: no whitespace errors and a clean worktree. Code gates do not need a third run because this plan changes Markdown only and the full post-review code gates already passed immediately before it.
