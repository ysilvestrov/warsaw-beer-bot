# Collab & Multi-Brewery Splitting Periphery Implementation Plan (#401, #589, #501)

> **For agentic workers:** REQUIRED SUB-SKILL: Follow `AGENTS.md` and the Superpowers workflow. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update specification documentation for `COLLAB_SEP` and `alias_alt` identity resolution, apply adjudication verdicts to the production database, and prepare for PR creation.

**Architecture:**
- `spec.md`: Document expanded `COLLAB_SEP` connectors and `alias_alt` leading brewery descriptor trimming + collab side admission.
- Operational / Database: Apply `adjudicate` verdict files to mark unrescued rows with `unrescued_at` and unlock rescued rows for cron retry.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `spec.md` | Modify | Document expanded collab splitting and alias_alt normalization rules |
| `docs/superpowers/plans/2026-09/2026-09-19-collab-multi-brewery-splitting-periphery.md` | Create | This periphery plan |

---

## Task 1: Update `spec.md`

**Files:**
- Modify: `spec.md`

- [ ] **Step 1: Document `COLLAB_SEP` expansion**:
  - In section on collaboration matching and `COLLAB_SEP`, specify support for non-spaced `&` (`Stone&Garage Beer Co.`, #589) and spaced `+` (`Nieczajna + Bistro Narożnik Brewery`, #401).
- [ ] **Step 2: Document `alias_alt` identity resolution enhancements**:
  - In section **Upstream identity evidence (#427)**, describe trimming leading brewery descriptors (`browar`, `brewery`, etc., #501) and admitting multi-token `COLLAB_SEP`-sides from the name for collaboration titles (`#401`).
- [ ] **Step 3: Run full gate**: `npm test && npm run typecheck`
- [ ] **Step 4: Commit**: `git commit -m "docs(spec): document expanded COLLAB_SEP and alias_alt collab resolution (#401, #589, #501)"`

---

## Task 2: Operational Adjudication Application

**Files:** None (database updates via `npm run adjudicate -- --apply`)

- [ ] **Step 1: Apply adjudication verdicts for #589**:
  - `sudo -u warsaw-beer-bot bash -lc "cd /home/ysi/warsaw-agy-bb/.worktrees/collab-splitting && npm run adjudicate -- --apply /tmp/adjudicate-589-*.json"`
- [ ] **Step 2: Apply adjudication verdicts for #501**:
  - `sudo -u warsaw-beer-bot bash -lc "cd /home/ysi/warsaw-agy-bb/.worktrees/collab-splitting && npm run adjudicate -- --apply /tmp/adjudicate-501-*.json"`
- [ ] **Step 3: Apply adjudication verdicts for #401**:
  - `sudo -u warsaw-beer-bot bash -lc "cd /home/ysi/warsaw-agy-bb/.worktrees/collab-splitting && npm run adjudicate -- --apply /tmp/adjudicate-401-*.json"`
- [ ] **Step 4: Verify production database state for cohort rows**:
  - Verify that unrescued rows have `unrescued_at` set and rescued rows are left unmarked for cron enrichment.

---

## Task 3: PR Preparation & User Confirmation

- [ ] **Step 1: Fetch origin/main and rebase if needed**:
  - `git fetch origin main && git rebase origin/main`
- [ ] **Step 2: Run full gate**:
  - `npm test && npm run typecheck`
- [ ] **Step 3: Ask user whether to create PR**.
