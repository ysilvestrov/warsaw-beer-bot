# #430 — one definition of the drink boundary, enforced at three points

Date: 2026-08-22
Status: agreed
Issue: #430
Related: `2026-08-15-377-triage-vocabulary-design.md` (introduced `not_a_beer` as the only
irreversible class), `2026-08-14-408-triage-verdict-guards-design.md` (the guards this bypasses),
`2026-07-29-ontap-identity-v2-design.md` (why a silent ingest drop is forbidden)
Measured from: the #419 checkpoint, 2026-08-22

## The model

> The boundary of "a drink we try to find on Untappd" is written down in two places that have
> never been reconciled, and the one with the irreversible consequence is the one that is wrong.

`src/sources/ontap/non-beer.ts` says cider, mead and kvass are eligible drinks and must pass.
`src/domain/triage-analysis.ts:204` says `wine/cider/cocktail/food` are `not_a_beer` — the single
class that permanently removes a row from both pools and is never revisited. Both statements have
been live since 2026-08-15. The second one wins, because it runs last.

Everything below follows from making that one boundary a single definition with three enforcers,
and from the fact that the safe place to test a *name* is after a failed search, not before it.

## Measured 2026-08-22 — four facts, in the order they change the design

### 1. The triage prompt has been burying cider for six days

15 rows carry `review_class = 'not_a_beer'` while being cider, mead or kvass. Every one was
reviewed between 2026-08-16 and 2026-08-21 — all written by the model under the #377 decision
tree, none by the #424 backfill. **8 of the 15 had `candidates_count > 0`**: Untappd returned
candidates and we buried the row anyway.

```
29906  pH                     Strong Apple Cider 8.5°           cand 0   "a cider, not a beer"
11989  CYDR DZIK Brewery      Cydr Gruszka                      cand 5   "not a beer"
31246  Chyliczki              Cydr Chyliczki - Japoński Sad     cand 5   "not a beer"
29931  Flasker                Maltdrikke Malt Beer KVAS         cand 0   "kvass, non-beer"
```

Against our own catalogue, which holds **1339 matched Untappd rows** in exactly those families:

| style | matched |
|---|---|
| Mead - Melomel | 332 |
| Cider - Dry | 116 |
| Mead - Braggot | 114 |
| Mead - Other | 111 |
| Kvass | 99 |
| Cider - Other Fruit | 92 |
| Cider - Traditional / Apfelwein | 64 |
| … 11 more Cider/Mead styles | … |

The pipeline matches these drinks every day. The rate of wrong irreversible verdicts is ~2.5/day.

### 2. A token filter applied BEFORE the search would destroy 554 real beers

The obvious design — reject non-beer words at ingest — is refuted by our own matched catalogue:

| token in `name` | **already-matched** Untappd beers |
|---|---|
| `wine` / `wino` / `vino` | **268** (barleywine, wine-barrel-aged) |
| `sausage`, `pizza`, `cake`, `burger`, `kielbas` | **257** (pastry stouts) |
| `spritz` | 9 |
| `mojito` | 8 |
| `cocktail` | 6 |
| `sangria` | 4 |
| `kombucha` | 2 |

Moving the test to the brewery field does not save it. A brewery-side token rule catches 14 of the
83 `not_a_beer` rows and collides with 14 matched beers — 1:1, i.e. worthless:

```
Vinohradský pivovar   Vinohradská 11        Pilsner - Czech / Bohemian   ← "vino" inside a district
Dwinell Country Ales  Field Guide           Farmhouse Ale - Saison       ← "wine" inside "Dwinell"
Hidden Legend Winery  Wild Elderberry Mead  Mead - Melomel
WINE BOYZ BAND        Spoko Cydr Zweigelt   Cider - Dry
```

**Conditioning on "already an orphan" is what makes a name-side rule safe.** Every one of those 554
beers matched, so none of them is ever in the orphan population. The false-positive set is not
reduced by the condition — it is very nearly *constructed away* by it.

### 3. The ingest filter exists, is wired, and leaks for one structural reason

`ontapTapExclusion` is called at `src/jobs/refresh-ontap.ts:83`, with history back to #156, and
#211 already established the eligible list. Replaying the **real** function against the **real**
tap rows behind the leaked orphans: **0 of 14 caught.** The split is the finding:

**6 of 14 the filter kept on purpose** — `Cydr Perry`, `Cydr tradycyjny`, `Cydr Chyliczki`,
`BLOOD ORANGE` (style `Cydr`), `Kwaśny Zdzichu` (style `Cydr wytrawny…`), `Borówka z miętą`
(style `Cydr`). `ELIGIBLE_STYLE_TOKENS` did its job. These rows were killed downstream, by fact 1.

**8 of 14 are genuine leaks, and 3 share one cause:**

```ts
const style = norm(tap.style);          // STYLE_TOKENS tested ONLY here
const brewery = norm(tap.brewery_ref);  // BREWERY_TOKENS tested ONLY here
return false;                           // tap.beer_ref is never tested for a drink token
```

`beer_ref` reaches the function only through the placeholder check. And **`style` is NULL on 64 of
the 83 rows**. So a tap that names its own drink type in the beer name is invisible to the filter:
`Culaccino / Aperol Spritz`, `Monte Santi / Hugo Spritz`, `Bianco Frizzante / Frizzante Bianco`.

The rest are enumerable gaps, each one token wide:

| leak | cause |
|---|---|
| `VINO KARPATIA / Biały bez` | `vino` is in `STYLE_TOKENS` but `BREWERY_TOKENS` has only `vini` |
| `Sangria / Sangria Czerwona` | `sangria` appears in no list at all |
| `Ima Distillery / Stefanówka` (style `Wódka ziemniaczana`) | no vodka token |
| `Bianco Frizzante / …` | `BREWERY_TOKENS` has `frizzanti`, not `frizzante` |
| `takie zero… / KRAN PUSTY. dużo°` | `PLACEHOLDER_PHRASES` has `kran w serwisie`, not `kran pusty` |
| `null / N/A` | no signal on any field |

### 4. The retry saving is real but modest — say so now

83 `not_a_beer` rows have consumed 170 Untappd searches; 53 of them have `fail_count = 1`. Daily
triage catches most rows on their first failure, so classifying at first failure saves ≈87 searches
lifetime — about half of the non-beer search traffic, not the 75% a backoff-cap argument suggests.
Triage slots are no longer scarce either: the untriaged pool is 4 (#419). **The primary value of
this work is correctness — cider stops being buried — not throughput.**

## Design

### One definition

`src/sources/ontap/non-beer.ts` stops being an ontap-private module and becomes the single home of
the boundary. Its name no longer fits its scope, so it moves to `src/domain/drink-boundary.ts`;
`src/sources/ontap/non-beer.ts` is deleted and its callers updated. The module exports:

- `ELIGIBLE_TOKENS` — cider/mead/kvass and friends. Unchanged in meaning, promoted to the module's
  headline export because two new consumers depend on it.
- `NON_BEER_NAME_TOKENS` — the narrow, name-safe subset used only after a failed search (below).
- `ontapTapExclusion(tap)` — unchanged signature; the ingest enforcer.
- `classifyOrphanAsNonBeer(row)` — the post-search enforcer.
- `eligibleFamiliesForPrompt()` — a rendered sentence the triage prompt interpolates.

**The boundary is never restated in prose anywhere.** The prompt does not spell out "cider is
eligible"; it interpolates `eligibleFamiliesForPrompt()`. A drift test asserts this (below). This
is the whole point of the change: two independent statements of one rule is what produced fact 1.

### Enforcer 0 — the triage prompt

`triage-analysis.ts:204` currently reads:

> Merch, glassware, wine/cider/cocktail/food, kombucha, and bundles: mystery boxes, multipacks,
> gift sets, "Brewery Pack".

`cider` is removed, and the eligible families are stated positively from the shared constant, with
the fact that makes it credible:

> Cider, mead, kvass and braggot ARE beer-adjacent — Untappd lists them and our catalogue already
> holds 1339 of them. Never class one as `not_a_beer` because it is not literally beer.

**Kombucha becomes eligible too** — this reverses #208/#214, on evidence they did not have. Untappd
carries two kombucha styles and our catalogue holds rows in both: `Hard Kombucha / Jun` (9) and
`Non-Alcoholic - Kombucha` (1). It is the same defect as cider at 1/100 the scale, and it was found
only because this spec asserted the opposite and the assertion was checked. `kombucha` therefore
moves out of `STYLE_TOKENS`/`BREWERY_TOKENS` and into `ELIGIBLE_TOKENS`.

The governing asymmetry, stated once and applied everywhere below: **being wrong toward "eligible"
costs one Untappd search; being wrong toward "not_a_beer" is irreversible.** Every judgement call in
this design resolves in that direction.

### Enforcer 1 — ingest, deliberately conservative

`ontapTapExclusion` keeps its shape: `style` and `brewery_ref` only, **no name-side test**. It gains
exactly the tokens fact 3 measured — `vino` and `sangria` and `frizzante` in the brewery list,
`wódka`/`wodka`/`vodka` and `sangria` in the style list, `kran pusty` in the placeholders.

Expected effect on the measured leak set: **5 of the 8 genuine leaks caught** (`VINO KARPATIA`,
`Sangria Czerwona`, `Frizzante Bianco`, the vodka, `KRAN PUSTY`). The remaining three — two bare
`… Spritz` names and `N/A` — are left to enforcer 2 on purpose. Adding `spritz` to a name test here
would be exactly the guess that fact 2 forbids.

The #306 rule is untouched: a tap the filter rejects is dropped and counted by cause, and the filter
may only reject on evidence in the source's own fields.

### Enforcer 2 — after a failed search, where names are safe

A new pure function, called from the enrich path at the moment a `not_found` failure is about to be
recorded:

```ts
classifyOrphanAsNonBeer(row: {
  brewery: string; name: string; style: string | null; candidates_count: number;
}): { nonBeer: true; token: string } | null
```

Three necessary conditions, all required:

1. **`candidates_count === 0`.** If Untappd returned anything, the row goes to the model. This
   deliberately leaves the 18-of-83 candidate-bearing rows to triage; it also removes the failure
   mode where a beer that missed on the *match* side is silently buried.
2. **No eligible token** anywhere in `brewery`, `name` or `style`. The eligible list is checked
   first and short-circuits, exactly as it already does at ingest.
3. **A `NON_BEER_NAME_TOKENS` hit on a word boundary.** Substring matching is banned here — it is
   what puts `wine` inside `Dwinell` and inside `barleywine`.

`NON_BEER_NAME_TOKENS` is **narrower than `STYLE_TOKENS` on purpose**: it holds only unambiguous
drink-category words — `spritz`, `sangria`, `mojito`, `prosecco`, `frizzante`, `aperol`,
`aperitivo`, `nalewka`, `wódka`/`vodka`, `szprycer`. It does **not** contain bare `wine`/`wino`/
`vino`: barleywine and barrel-aged names make those unsafe even on a word boundary, and the brewery
side already catches the wine producers that name themselves.

On a hit the failure row is written with `review_class = 'not_a_beer'`, `issue_number = NULL` and
`review_note = "auto: <token>"`. The row therefore never enters the untriaged pool, is never
retried, and never reaches the model.

### Enforcer 2 ships in shadow mode

The rule does **not** write on its first deploy. It logs what it *would* classify
(`drink-boundary: would classify`, with `beer_id`, `token`, `name`) and writes nothing. Flipping it
on is a one-line change, gated on a week of comparing the shadow log against what the model decided
for the same rows.

This is not ceremony. Fact 1 is a rule that ran unattended for six days and destroyed rows nobody
was watching; the cost of a week's delay is ~87 searches, and the cost of being wrong is
irreversible. The comparison is the deliverable of the follow-up issue, not of this one.

### Repair — un-bury the 15

`not_a_beer` is the only hard pool exclusion, so clearing it restores the row to both pools with no
other machinery. For each of the 15 rows: `review_class`, `review_note`, `reviewed_at` and
`issue_number` back to NULL, leaving `fail_count`/`last_at` alone so backoff history is preserved.

Selection is by **explicit `beer_id` list**, not by a `LIKE` predicate — the list is enumerated in
the plan from the query in fact 1, so the write cannot widen if a token matches something unexpected.
Per project policy the statement is dry-run against a `VACUUM INTO` copy of the prod DB first, and
the before/after counts of `not_a_beer` and of the untriaged pool are reconciled.

## Interfaces

| unit | responsibility | depends on |
|---|---|---|
| `domain/drink-boundary.ts` | the boundary: eligible families, non-beer tokens, both enforcer predicates, the prompt fragment | `sources/ontap/identity.breweryCore` — `src/domain/` already imports from `src/sources/` in 8 modules (`bid-identity`, `triage-verify`, `untappd-lookup`, …), so this is the established direction, not a new one |
| `jobs/refresh-ontap.ts` | calls `ontapTapExclusion`, counts drops by cause | drink-boundary |
| the enrich failure path | calls `classifyOrphanAsNonBeer` before recording a `not_found` row | drink-boundary |
| `domain/triage-analysis.ts` | interpolates `eligibleFamiliesForPrompt()` into the decision tree | drink-boundary |

The triage guards (#408), the verification gate (#358) and `planTriageActions` are **not touched**.
A row classified by enforcer 2 never reaches them.

## Testing

- **Fixtures are the measured leaks.** The 14 recovered tap rows become a table-driven test:
  the 6 eligible ones must stay, the 5 newly-covered ones must be caught, the 3 deferred ones must
  still leak (asserted explicitly, so a later change that catches them is a visible decision).
- **A false-positive regression set** drawn from the 554: a barleywine, a `Dwinell Country Ales`
  row, a pastry stout with `cake`, `Sausage Fingers`, a `Vinohradský pivovar` lager, and a
  `Hard Kombucha / Jun` row. Enforcer 2 must return `null` for every one of them at
  `candidates_count = 0`.
- **Drift test.** Assert that the built triage prompt contains every token in `ELIGIBLE_TOKENS`
  and contains none of them in the `not_a_beer` clause. This is the test that would have caught
  fact 1 on the day #377 shipped, and it is the reason the constant is shared rather than copied.
- **Mutation proof.** Each added token is removed in turn; a named test must go red. Each of the
  three conditions in enforcer 2 is disabled in turn; a named test must go red.
- **Shadow-mode test.** With shadow on, a row the rule would classify is written with
  `review_class = NULL` and the log line is emitted. Assert the DB write, not just the log.

## What this deliberately does not do

- **It does not fix #430 as filed.** The routing question — an actionable verdict that names no
  issue — survives for the rows enforcer 2 declines to touch. After this ships the `not_a_beer`
  population is deterministic and small, which is the state in which that question is worth
  answering. #430 is rewritten to that narrower scope and blocked on this.
- **It does not probe candidate styles.** Using the styles inside `candidates_summary` as evidence
  is a real option and is deliberately unused: condition 1 sends every candidate-bearing row to the
  model instead. Revisit only if the shadow comparison says the 18-row cohort matters.
- **It does not touch the shop adapters.** 15 of the 83 rows come from flasker/beerfreak/
  beerrepublic. Enforcer 2 covers them by construction because it runs on the failure path, not on
  ontap. No shop-side ingest filter is proposed here.

## Follow-ups this spawns

1. Flip enforcer 2 out of shadow mode after a week of comparison (blocking on evidence, not time).
2. #430 rewritten: routing for actionable verdicts that name no issue.
3. The 3 deferred leaks (`Aperol Spritz`, `Hugo Spritz`, `N/A`) if enforcer 2 does not cover them
   in practice.
