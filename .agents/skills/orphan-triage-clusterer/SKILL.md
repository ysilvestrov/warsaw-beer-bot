---
name: orphan-triage-clusterer
description: Periodically catalogs, clusters, and analyzes open orphan-triage issues to identify high-impact defect clusters, decompose sinkholes, and guide architectural fixes.
---

# Orphan-Triage Issue Clusterer & Architect

## Purpose

The repository's daily cron (`src/jobs/orphan-triage.ts`) creates and routes GitHub issues for attribution failures (`enrich_failures`) without direct access to the code. Consequently, issues become duplicated, conflated, or misclassified (e.g. shop adapter failures misattributed as backend matcher bugs).

This skill provides an automated workflow to:
1. Catalog all open `orphan-triage` issues.
2. Group issues by true **Architectural Locus** (`adapter_bug`, `query_normalizer_bug`, `entity_alias_bug`, `matcher_gate_bug`, `sinkhole_debris`).
3. Compute an objective **Impact Score** balancing cohort size, systemic leverage, and blast radius.
4. Pick the top-priority cluster and prepare an architectural fix design following the project's **Superpowers** workflow (`AGENTS.md`).

---

## Workflow Steps

### Step 1: Catalog & Cluster Open Issues

Run the clustering script to fetch all open `orphan-triage` issues and classify them:

```bash
npm run cluster-triage
```

Or generate a detailed Markdown report:

```bash
npm run cluster-triage -- --markdown
```

### Step 2: Evaluate the Top-Impact Cluster

Clusters are ranked by:
$$\text{Impact Score} = \frac{\text{LiveBeerCount} \times \text{Leverage} \times 10}{\text{BlastRadius} \times \text{Complexity}}$$

Key principles from `AGENTS.md` and `docs/orphan-triage-issues-runbook.md`:
- **Shop adapters (`adapter_bug`)** have high leverage and the lowest blast radius (isolated to one shop domain).
- **Query normalizers (`query_normalizer_bug`)** rescue entire categories of zero-candidate searches.
- **Debris/Sinkholes (`sinkhole_debris`)** like #334, #405, #406 must be decomposed and their rows remapped explicitly.

### Step 3: Run Replay Spike & Verify Candidates

Before writing any fix code, replay the cohort examples against Untappd (spike):
- For browser extension shop adapters: inspect fixtures in `extension/tests/fixtures/` and test extraction locally.
- For backend matcher/normalizer issues: run candidate searches and test `cleanSearchQuery` / `searchQueryLadder`.

### Step 4: Author the Architectural Design (OpenSpec)

Following `AGENTS.md`, if the change introduces a new rule or touches >2 files:
- Create `docs/superpowers/specs/<YYYY-MM>/YYYY-MM-DD-<topic>-design.md`.
- Include the mandatory **"Claims and Their Evidence"** table.
- Define explicit test cases and regression guards.

### Step 5: Safe Row Remapping & Adjudication

Remember the database invariants (§3.13):
- Closing an issue re-arms all its rows via `unlock-fixed-orphans`.
- Run adjudication before closing:
  ```bash
  npm run adjudicate -- --issue <N>
  npm run adjudicate -- --apply <verdict-file>
  ```
- When decomposing an issue or consolidating duplicates, remap rows row-by-row:
  ```bash
  sudo -u warsaw-beer-bot bash -lc "sqlite3 /var/lib/warsaw-beer-bot/bot.db \
    \"UPDATE enrich_failures SET issue_number = <target> WHERE beer_id IN (<ids>)\""
  ```
