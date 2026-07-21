# Czech grade (°Plato) naming reconciliation — enrichment matcher

**Issue:** #321 (`matcher-bug`, tier-2). Split from #254.
**Date:** 2026-07-21
**Scope:** Enrichment lookup only (`lookupBeer` in `src/domain/untappd-lookup.ts`). No change to the live `/match` catalog path, no change to how Untappd is queried.

## Problem

Czech beers are commonly named by their **°Plato grade** — a number (`8`, `10`, `11`, `12`) or the
spelled-out grade word (`osmička`=8, `desítka`=10, `jedenáctka`=11, `dvanáctka`=12). Crucially, in
Czech naming this grade denotes a **pale lager** (`světlý ležák` / `výčepní`) — it is *never* an ale
style. `Nachmelená Opice 11` is an 11° pale lager, never the gose or session IPA the brewery also
makes.

The current pipeline destroys the grade on both the shop and Untappd side, so a beer distinguished
only by its grade can never match:

- `isNumericNoise` (`normalize.ts`) strips bare integers (`10`/`11`/`12`) from `normalizeName`.
- `stripSearchNoise` strips `11%` / `11°` to nothing.
- Spelled grade words (`desítka`, `dvanáctka`, …) have no mapping to their numeral.

**Key observation:** retrieval already works. Every failing orphan below *has* its correct
candidate in `enrich_failures.candidates_summary`. The miss is purely in **selection**. So the fix
is a new selection stage, not a query change.

### Real orphans (`enrich_failures`, `review_class='matcher_bug'`)

| beer_id | shop brewery / name | candidate(s) | intended hit |
|---|---|---|---|
| 12141 | Kamenice nad Lipou / `Desitka` | `Kamenická 10` (1) | Kamenická 10 |
| 29429 | Kamenica / `Dvanastka` | `Kamenická 12`, `Spílková Dvanáctka` (2) | either (same brewery, 12°) |
| 29556 | Kamenica / `Desitka` | `Kamenická 10` + 2 other breweries (4) | Kamenická 10 |
| 12007 | Nachmelená Opice / `11` | `Ležák 11%`, `Góséčko 11%`, `Session IPA 11%` (5) | Ležák 11% |
| 31800 | Pivovar Krakonoš / `Trutnov 11` | `Světlý ležák 11°` ×3 (plain / Vánoční / Velikonoční) (3) | plain Světlý ležák 11° |
| 31421 | `Premium pszenica` | (0 candidates) | none — misfiled (Polish wheat), left untouched |

## Design

A new **grade-reconciliation matching stage** in `lookupBeer`, evaluated **last** (after Stage 2a
exact-key, 2a.5 near-name, 2b fuzzy, relaxed-exact, and brand stages all miss) and on the **strict
brewery pool only**. Running last means it never overrides a stronger name match; strict-only keeps
the false-positive surface small.

### New module: `src/domain/czech-grade.ts`

Isolated and unit-tested (per CLAUDE.md: new logic modules need tests before merge).

- `CZECH_GRADE_WORDS: Map<string, number>` — curated spelled-word → grade map, keys already
  diacritic-stripped/lowercased to match `baseNormalize` output. Seeded with observed forms and
  common shop misspellings:
  `osmicka`→8, `devitka`→9, `desitka`→10, `jedenactka`→11, `dvanactka`→12, `dvanastka`→12,
  `trinactka`→13, `ctrnactka`→14. Growable (same spirit as the curated brewery aliases).
- `GRADE_MIN = 7`, `GRADE_MAX = 20` — Plato range for the bare-integer path.
- `ALE_STYLE_WORDS: Set<string>` — `ipa apa neipa dipa tipa aipa gose stout porter sour saison
  lambic weizen wheat witbier barleywine` (grade never denotes these).
- `DARK_WORDS: Set<string>` — `tmavy tmava tmave cerny cerne dark` (Czech pale is the default; a
  plain grade must not grab a dark variant).
- `LAGER_KEYWORDS: Set<string>` — `lezak vycepni svetly svetle lager` (color/lager tokens that are
  *not* extra descriptors when counting distinctiveness).
- `extractGrade(name: string): number | null` — tokenizes `baseNormalize(name)` (numbers
  preserved; **not** `normalizeName`), returns the first token that is either a
  `CZECH_GRADE_WORDS` key or a bare integer in `[GRADE_MIN, GRADE_MAX]`. Returns `null` otherwise.

### The stage (in `untappd-lookup.ts`)

Guard: only reached when `strictPool.length > 0` and `extractGrade(inputName) !== null`.

1. `g = extractGrade(name)`. If `null`, skip the stage.
2. **Same-grade filter:** keep strict candidates where `extractGrade(candidate.beer_name) === g`.
3. **Style exclusion:** drop any surviving candidate whose `baseNormalize(beer_name)` tokens
   intersect `ALE_STYLE_WORDS`; also drop candidates whose tokens intersect `DARK_WORDS` **unless**
   the input name is itself dark (its `baseNormalize` tokens intersect `DARK_WORDS`).
4. **Rank survivors** by fewest **extra descriptor tokens** — `baseNormalize(beer_name)` tokens
   minus brand tokens (`normalizeBrewery(candidate.brewery_name)`), minus the grade token, minus
   `LAGER_KEYWORDS`. Lower count wins (plain lager beats a seasonal). Tie-break: an ABV within
   `ABV_TOLERANCE` of the input `abv` (when provided), then first (search results are latest-first).
5. If ≥1 survivor → `{ kind: 'matched', result }`. Else fall through to the existing `not_found`.

### Worked resolution

- `Desitka`→10 → `Kamenická 10` sole survivor.
- `Dvanastka`→12 → `Kamenická 12` (kamenicka=1 desc) vs `Spílková Dvanáctka` (spilkova=1 desc) →
  ABV/first tiebreak. Ambiguity accepted (user chose auto-resolve).
- `11` → `Session IPA` excluded (ale), `Ležák`(0 desc) beats `Góséčko …`(≥2 desc).
- `Trutnov 11` → plain `Světlý ležák 11°`(0 desc) beats Vánoční/Velikonoční(1 desc each).
- `Premium pszenica` → `extractGrade` null → stage skipped, stays orphan.

## False-positive protection

- Strict brewery gate must already pass.
- Runs only as a last resort (all name stages missed).
- Requires a same-grade candidate to exist; a bare `8/10/11/12` with no strict same-grade candidate
  never fires.
- Bare integers gated to `[7, 20]` — `Pinta 555`, vintage years, etc. never trigger.

## Testing

- `czech-grade.test.ts`: `extractGrade` for spelled words (incl. `dvanastka` variant), bare
  integers, range bounds (6/21 → null), non-grade names → null; dark detection.
- `untappd-lookup` stage tests driven by the 5 real orphan fixtures (same-grade filter, ale
  exclusion, dark exclusion, fewest-token tiebreak, ABV tiebreak).

## Deploy / re-arm

After merge + deploy, the affected orphans are backed-off and won't retry on their own. Re-arm them
(reset `fail_count`/backoff) via the compiled `dist` rearm path run as the `warsaw-beer-bot` user
(the tsx `scripts/*` tools are pruned in `/opt`). Confirm the 5 orphans clear on the next
enrichment cycle.

## Out of scope

- The live `/match` catalog path (different flow; could adopt the same helper later).
- Parser-side °Plato handling (#306 — Konrad/Krakonoš name residue) — that is the parser half.
- Bare-number grades where **no** candidate shares the grade (nothing to reconcile against).
- Flavour-word PL/UK→EN translation (#322) — separate.
