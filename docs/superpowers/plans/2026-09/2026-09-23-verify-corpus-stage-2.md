# Verify Corpus — Stage 2 (Filling the Corpus) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grow the verify corpus from 5 entries to a set that can actually discriminate between judge models, and prove per entry that its verdict is settleable from the one file body `verify` sends.

**Architecture:** No new code. Every task adds entries to `scripts/ai-review/verify-corpus.json` and proves them with the existing `npm run verify-corpus -- --check`. The work is adjudication, not engineering: each entry's expected verdict must be established by reading the tree, and each must pass the in-file evidence rule.

**Tech Stack:** The stage-1 instrument as shipped — `verify-corpus.json`, `loadCorpus`, `--check`.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-23-verify-corpus-and-runner-design.md`

## Why this stage exists, measured rather than assumed

The 2026-09-23 measurement ran `gpt-5.5` and `claude-sonnet-5` against the 5-entry corpus, three draws each. The result was **identical**: union `confirmed 3/3 · refuted 3/3`, consensus `confirmed 2/3 · refuted 3/3`, both wavering on the same single entry and nothing else. That is not evidence the two judges are equal — it is evidence **the corpus cannot tell them apart**. Sonnet costs ≈24% less on this stage, and a 24% saving on ~40% of the bill is not worth swapping the judge on the word of an instrument that admits it discriminates nothing.

So stage 2's success criterion is not "more entries". It is: **the corpus separates two judges, or shows with adequate draws that they do not differ.**

## Global Constraints

- **The in-file evidence rule is absolute.** An entry whose verdict turns on anything outside the one file body `verify` sends does not enter the corpus. This rule is a judgement and was deliberately NOT mechanised — see the design's "Механічну перевірку пробували й відкинули" section, and do not rebuild that check.
- **A baseline label is not a corpus label.** The 2026-07 `real`/`false` labels say whether a defect is genuine. A corpus `expected` says what the judge **should answer given this input**. They coincide only when the evidence is in-file.
- **Every `expected` is established by reading the tree**, never transcribed from a summary and never inferred from the claim's wording. Record the construct in `why_expected`.
- **`out_of_scope` is not a valid `expected` value.** An entry that would need it does not belong in v1.
- **`npm run verify-corpus -- --check` must pass on every entry, and it is the proof of the quote/span/sha work** — not a formality. Run it after every task.
- **Quotes are copied out of the tree with `git show`, never retyped.** Indentation is part of the quote.
- Run the FULL gate each task: `npm test && npm run typecheck`.
- `sha` values are full 40-character hex; the schema enforces it.

---

### Task 1: The three unused #418 defects as known-true entries

**Why first:** the corpus has only **2** known-true entries and both are in the same file at the same sha (`triage-plan.ts` @ `584aa661`). A judge that happens to read that one file well looks good on all the known-true evidence there is. D1, D2 and D5 are known-true from the same fix commit, live in **three different files**, and each is settleable in-file.

**Files:**
- Modify: `scripts/ai-review/verify-corpus.json`
- Test: `scripts/ai-review/verify-corpus.test.ts`

**Interfaces:**
- Consumes: `CorpusEntry` as shipped (13 fields).
- Produces: three new ids — `0923-418-D1`, `0923-418-D2`, `0923-418-D5`.

The ground truth is the fix commit `2170717fc247ce202acc6ffd731fbea277f06a54`, section "fix(#408): close all five findings from the AI review" — "All five were valid on inspection; none were declined." Read it with `git log -1 --format=%B 2170717`.

- [ ] **Step 1: Establish each defect's in-file evidence at `584aa66183e55e4371819c9c5b19b2662ddaa6a2`**

For each, print the region and confirm the claim is settleable from that file alone:

```bash
SHA=584aa66183e55e4371819c9c5b19b2662ddaa6a2
# D1 — a model-authored issue body can hijack the scope: BLOCK_RE is unanchored
# and parseScopeBlock takes the FIRST match, while issue.body (model prose) is
# rendered BEFORE our block.
git show $SHA:src/domain/triage-scope.ts | sed -n '120,170p'
# D2 — isLegalScope lets a cohort launder a whole-class `where`.
git show $SHA:src/domain/triage-scope.ts | sed -n '30,45p'
# D5 — the tool schema advertises col/op as free strings.
git show $SHA:src/domain/triage-analysis.ts | sed -n '95,125p'
```

Expected: D1's evidence is `BLOCK_RE` plus the single `BLOCK_RE.exec(body)` in `triage-scope.ts`; D2's is `isLegalScope`'s `if (scope.beer_ids.length > 0) return true;`; D5's is the free-string `col`/`op` properties in the tool schema. **If any one of them cannot be settled from its own file, that entry is dropped and the task reports why** — the in-file rule outranks the wish for three entries.

- [ ] **Step 2: Write the three entries**

Append to `scripts/ai-review/verify-corpus.json`, copying each quote with `git show … | sed -n '<a>,<b>p'` and setting `matchedEndLine - matchedLine + 1` to the quote's line count. `provenance` is `harvested` (a live review raised all five), `source` names the PR and the fix commit, `quoteOrigin` is `reconstructed`, `expected` is `confirmed`, and `why_expected` names the construct in that file — not the fix.

- [ ] **Step 3: Prove them**

Run: `npm run verify-corpus -- --check`
Expected: 8 entries, all `ok`, exit 0.

- [ ] **Step 4: Update the corpus test**

In `scripts/ai-review/verify-corpus.test.ts`, change the count assertion to `8` and add:

```typescript
  // Stage 2, task 1: known-true entries must not all sit in one file, or a judge
  // that reads that file well scores perfectly on every confirmable claim there is.
  it('spreads the known-true entries over more than one file', () => {
    const confirmed = loadCorpus().filter((e) => e.expected === 'confirmed');
    expect(new Set(confirmed.map((e) => e.file)).size).toBeGreaterThan(1);
  });
```

- [ ] **Step 5: Full gate**

Run: `npm test && npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add scripts/ai-review/verify-corpus.json scripts/ai-review/verify-corpus.test.ts
git commit -m "feat(verify-corpus): три невикористані дефекти #418 як відомо-справжні записи

Корпус мав лише два відомо-справжні записи, обидва в одному файлі на одному sha —
суддя, який добре читає той файл, виглядав ідеальним на всій підтверджуваній
частині. D1, D2 і D5 із того ж коміта-фікса живуть у трьох різних файлах і
кожен установлюється з власного файлу."
```

---

### Task 2: The 2026-07 known-false claims that survive the in-file rule

**Why:** the harvested known-false side is 2 entries. The 2026-07 baseline holds **13** `false` labels across five PRs and several domains (migrations, quota, promise gates, logging, query tokens) — the "confident invention" failure mode a judge must catch. But each must be re-checked against the in-file rule before it enters, and **some will fail it**.

**Files:**
- Modify: `scripts/ai-review/verify-corpus.json`
- Test: `scripts/ai-review/verify-corpus.test.ts`

**Interfaces:**
- Produces: up to 11 new ids of the form `<MMDD>-<PR>-<n>`, skipping `0726-348-4` and `0728-358-4` (already in) and the one `real` entry (removed in stage 1).

Source of the labels and their evidence: `docs/superpowers/specs/2026-07/2026-07-28-ai-review-baseline-labels.md`. The reviewed head of each PR comes from the review itself, not from the merge commit:

```bash
for pr in 344 348 352 356 358; do
  gh api repos/ysilvestrov/warsaw-beer-bot/pulls/$pr/reviews \
    -q '.[]|select(.body|test("ai-pr-review"))|"'$pr' \(.commit_id)"'
done
```

- [ ] **Step 1: Adjudicate every candidate against the in-file rule, and write the table down**

For each of the 11 remaining `false` rows, produce one row of a table in the task report:

| id | file | the construct that settles it | in the same file? | verdict |
|---|---|---|---|---|

An entry enters the corpus only when the third column names something in the **same** file as the claim. Expect genuine casualties: the baseline's own evidence for `#352-1` turns on the ORDER of two calls (`isWebFallbackBlocked` before `tryConsumeWebSearchQuota`), and `#348-1` turns on what `ALTER TABLE … RENAME COLUMN` does, which is SQLite behaviour rather than text in the file. **Judge each one; do not stretch the rule to hit a count.** A task that admits 6 of 11 and says why is a better outcome than one that admits 11.

- [ ] **Step 2: Write the surviving entries**

Same mechanics as Task 1: quotes via `git show` at that PR's reviewed head, span equal to the quote's line count, `provenance: "harvested"`, `expected: "refuted"`, `why_expected` naming the in-file construct. `source` cites the PR, its review date and the baseline document's row.

- [ ] **Step 3: Prove them**

Run: `npm run verify-corpus -- --check`
Expected: every entry `ok`, exit 0.

- [ ] **Step 4: Update the count assertion and add the skew guard**

```typescript
  // Stage 2, task 2: the report splits by expected verdict precisely because the
  // corpus is skewed, but the skew must stay describable — if refuted entries
  // outnumber confirmed ones by more than 3:1 a judge answering `refuted` to
  // everything scores over 75% on the aggregate line a reader skims first.
  it('keeps the refuted-to-confirmed ratio under 3:1', () => {
    const corpus = loadCorpus();
    const refuted = corpus.filter((e) => e.expected === 'refuted').length;
    const confirmed = corpus.filter((e) => e.expected === 'confirmed').length;
    expect(refuted / confirmed).toBeLessThan(3);
  });
```

- [ ] **Step 5: Full gate, then commit**

```bash
npm test && npm run typecheck
git add scripts/ai-review/verify-corpus.json scripts/ai-review/verify-corpus.test.ts
git commit -m "feat(verify-corpus): хибні твердження baseline 2026-07, що пройшли правило доказу в файлі

Кожен кандидат переадюдикований: мітка baseline каже, чи дефект справжній, а
мітка корпусу — що суддя МАЄ відповісти на цей вхід, і вони збігаються лише коли
доказ у тому самому файлі. Відсіяні записи названі в звіті задачі з причиною."
```

---

### Task 3: Time shifts for the #418 defects

**Why:** the constructed side is one entry. A time shift — the same claim judged against the tree that fixed it — is the only entry kind that cannot be harvested at all, and it is the sharpest test of whether a judge reads the tree instead of recognising a pattern it has seen.

**Files:**
- Modify: `scripts/ai-review/verify-corpus.json`
- Test: `scripts/ai-review/verify-corpus.test.ts`

**Interfaces:**
- Produces: ids `0923-418-D1t`, `0923-418-D2t`, `0923-418-D5t` (as many as survive).

- [ ] **Step 1: Confirm each fix is visible in the fixed tree**

```bash
FIX=2170717fc247ce202acc6ffd731fbea277f06a54
git show $FIX:src/domain/triage-scope.ts | grep -n "stripScopeBlocks" # D1's fix
git show $FIX:src/domain/triage-scope.ts | grep -n -A8 "export function isLegalScope" # D2's fix
git show $FIX:src/domain/triage-analysis.ts | grep -n "enum" # D5's fix
```

A time shift is only valid when the fixed tree **visibly** contradicts the claim in the file the judge sees. If a fix landed in a different file than the claim's, that shift fails the in-file rule and is dropped.

- [ ] **Step 2: Write the surviving shifts**

Each carries the **same `claim` and `why_it_breaks`** as its known-true twin, `sha` of the fixed tree, `provenance: "constructed"`, `expected: "refuted"`, and a `why_expected` naming the construct that now contradicts it. `source` states it is a time shift of the twin's id.

- [ ] **Step 3: Prove them, and prove the pairing**

Run: `npm run verify-corpus -- --check` — every entry `ok`.

Then add:

```typescript
  // A time shift is only meaningful as a PAIR: the same claim, opposite verdicts,
  // either side of the fix. An unpaired shift measures nothing in particular.
  it('pairs every constructed entry with a known-true twin carrying the same claim', () => {
    const corpus = loadCorpus();
    for (const shifted of corpus.filter((e) => e.provenance === 'constructed')) {
      const twin = corpus.find((e) => e.claim === shifted.claim && e.expected === 'confirmed');
      expect(twin, `no confirmed twin for ${shifted.id}`).toBeDefined();
      expect(twin!.sha).not.toBe(shifted.sha);
    }
  });
```

- [ ] **Step 4: Full gate, then commit**

```bash
npm test && npm run typecheck
git add scripts/ai-review/verify-corpus.json scripts/ai-review/verify-corpus.test.ts
git commit -m "feat(verify-corpus): часові зсуви решти дефектів #418

Те саме твердження проти дерева, яке його полагодило — єдиний вид запису, який
неможливо зібрати, і найточніша перевірка того, чи суддя читає дерево, а не
згадує патерн. Кожен зсув спарований зі своїм відомо-справжнім близнюком."
```

---

### Task 4: Re-measure both judges on the filled corpus

**Files:** none modified — this task produces a measurement and a document entry.
- Modify: `docs/ai-review-model-evaluation.md` (a new results-log entry)

- [ ] **Step 1: Prove the corpus before spending anything**

Run: `npm run verify-corpus -- --check`
Expected: every entry `ok`, exit 0. A failure here voids any measurement that follows.

- [ ] **Step 2: Measure both judges, three draws each, in one session**

```bash
export OPENAI_API_ENDPOINT=https://api.openai.com/v1
export OPENAI_API_KEY=$(tr -d '\r\n ' < tmp/openai.key)
npm run verify-corpus -- --model gpt-5.5 --draws 3

export OPENAI_API_ENDPOINT=https://api.anthropic.com/v1
export OPENAI_API_KEY=$(tr -d '\r\n ' < tmp/claude.key)
npm run verify-corpus -- --model claude-sonnet-5 --draws 3
```

The incumbent is re-measured here, not compared against the stored 2026-09-23 numbers.

- [ ] **Step 3: Read the CONSENSUS line, not the union**

The union counts an entry correct if any draw was. Over three binary draws a judge answering at random is right at least once with p ≈ 0.875 per entry, so a union row alone cannot distinguish a coin-flipper from a perfect judge. Compare consensus to consensus and draw to draw.

- [ ] **Step 4: Price the comparison from tokens, not from the rate card**

`claude-sonnet-5` has no `PRICES` row, so its cost prints as unpriced — compute it as `prompt × $2/1M + completion × $10/1M` and compare against the incumbent's printed figure. Measured 2026-09-23: Anthropic counted **1.65×** the input tokens and **2.19×** the output on verify prompts, so the nominal −60% was really **−24%**. Recompute; do not reuse that ratio.

- [ ] **Step 5: Write the results-log entry**

Append a dated entry to `docs/ai-review-model-evaluation.md` under `# Results log`, in the established shape: what was measured, on what corpus, per-draw and consensus numbers for both judges, the recomputed cost, and what it settles. If the corpus still cannot separate the two, **say so plainly** and say what would — more entries, more draws, or a harder entry class. An instrument that admits it discriminates nothing is worth more than a recommendation it cannot support.

- [ ] **Step 6: Commit**

```bash
git add docs/ai-review-model-evaluation.md
git commit -m "docs(ai-review): verify-суддя зміряний на заповненому корпусі"
```

---

## Self-Review

**1. Spec coverage.**

| spec requirement | task |
|---|---|
| remaining 2026-07 known-false entries | Task 2 |
| adjudicate the 12 DeepSeek claims | **deliberately excluded — see below** |
| time shifts for the other #418 defects | Task 3 |
| the in-file evidence rule applied per entry | Tasks 1, 2, 3 (each has an explicit adjudication step) |
| `spec.md` / protocol updates | Task 4 (results-log entry); `spec.md` needs no change — no command or behaviour changes in this stage |

**The DeepSeek 12 are dropped from this stage, and that is a change to the spec's stage-2 list.** Reason: they are `gpt-5.5`'s labels, so adjudicating them means establishing 12 verdicts by hand — and the in-file rule will disqualify a large share of them, because ten of the twelve cluster on two files and mostly on one mechanism (backtick escaping in the scope block), where the claims contradict each other about which direction the escape fails. The cost is high, the yield is low and correlated, and Tasks 1–3 already supply both verdict classes across more files. They stay in `docs/ai-review-fabrication-corpus-2026-09-22.md`, available if Task 4 shows the corpus still cannot discriminate. Recorded here so the omission is a decision, not a silent drop.

**2. Placeholder scan.** No "TBD", no "add entries as appropriate". Every task names its source of truth, its shas, its commands, and what to do when an entry fails the rule. The per-entry values are deliberately NOT pre-filled — they must be read out of the trees, and pre-writing them would be the retyping the constraints forbid.

**3. Type consistency.** No new types. All four tasks use `CorpusEntry` as shipped and the existing `--check`. Test helpers (`loadCorpus`) already exist.

**4. Ordering.** Task 1 is independent. Task 3 depends on Task 1 (its shifts pair with Task 1's twins). Task 2 is independent of both. Task 4 is last by construction.
