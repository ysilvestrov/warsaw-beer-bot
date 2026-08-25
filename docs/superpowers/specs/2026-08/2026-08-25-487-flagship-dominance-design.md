# #487 — popularity decides the flagship, ABV only vetoes

Date: 2026-08-25
Status: agreed
Issues: #487 (ABV picks the candidate even when an exact name match exists)
Related: #409 (tied near-name candidates resolved by search result order — the same family, one
stage over), #306 (`isBareBrandName`: the local matcher already refuses to attach an arbitrary
product of a brewery), #484 (a `0` ABV trusted too much as a veto — the mirror image of this),
#417 (row 196 is locked behind it; closing #417 without this ships the wrong link)
Spawned: the digit-identity defect (`normalizeName` deletes the number that IS the beer's name),
filed separately — see "Deliberately not in scope"
Measured from: production `bot.db` on 2026-08-25 (707 live orphan rows, 31 347 matched beers) and
live Algolia replays on the same day, against `main` = `fa9a6e4`

## The model

> Two signals can name a beer: what it is called, and how strong it is. The name is identity; the
> ABV is a property. Today, once the name signal is gone, the property is promoted to identity —
> and a property that a shop typed 0.5 % wrong then picks a different product with full confidence.

The fix is not to make ABV weaker everywhere. Where an **exact name key** matched, ABV is doing
honest work: it separates the 2024 and 2025 vintages of one beer, which normalize to the same name.
The defect is only where **no exact name evidence exists at all** — there ABV is not breaking a tie
inside an equivalence class, it is choosing between classes.

What replaces it is the signal a drinker actually uses. Asked for "a Guinness", nobody means
Guinness Bitter; they mean the beer with 992 660 ratings. Popularity is identity evidence when one
candidate dominates, and no evidence at all when two siblings are neck and neck. So: **popularity
decides, ABV vetoes, and no dominance means no match.**

## The issue's stated mechanism is wrong — measured

#487 says an exact name match exists and is overruled. Live replay on 2026-08-25 (`fa9a6e4`,
post-#486/#430) reproduces the wrong link, but by a different route.

```
Kronenbourg Brewery / Kronenbourg 1664 @5.0
  abv=5.0  -> matched bid=5999 1664 Blanc   (wrong)   [untappd-lookup.ts:508-517]
  abv=null -> not_found
  abv=5.5  -> matched bid=5939 1664         (right)
```

Three facts the issue does not contain:

1. **There is no exact name match to overrule.** `isNumericNoise` (`normalize.ts:141`) strips
   pure-digit tokens, so `normalizeName('1664')` is the **empty string** and
   `normalizeName('Kronenbourg 1664')` is `kronenbourg`. `stripBreweryFromName` refuses to strip a
   name to nothing, so the target the name stages compare is literally the brewery brand.
2. **The tie is manufactured by a bare-brand alias.** Both bid=5939 and bid=5999 carry
   `alias_alt: ['…', 'kronenbourg', …]`. `nativeNearNameScore` takes the maximum over `alias_alt`,
   so both score exactly **1.0** against the target `kronenbourg`. The scores are equal because the
   same content-free brand string sits on both sides.
3. **Only then does ABV act**, as the sole discriminator in `pickUniqueByAbv`.

Implementing what #487 proposes — an exact name outranking ABV — would leave row 196 unchanged.
The issue's *principle* is right ("ABV should break ties within an equivalence class, not select
across classes"); its account of the mechanism is not.

## Measured 2026-08-25

### 1. The signal is already in the response we fetch

A raw Algolia beer record carries `rating_count` and `popularity`, which `parseAlgoliaResponse`
discards — only `rating_score` is kept (`algolia.ts:52`).

```
Guinness — Guinness Draught   rating_count=992660  popularity=3924470
Guinness — Smithwick's        rating_count=330477
Stella Artois — Stella Artois rating_count=710790
Stella Artois — Cidre         rating_count=78802
```

No extra request is needed, and the relay path shares the same parser (`enrich.ts:282`), so the
extension's Algolia payloads gain the field at the same time. The legacy HTML relay (`htmlSearch`)
has no such field; there the rule simply never fires.

### 2. There is a clean gap between the flagships and the coin flips

All 33 live orphan rows whose target collapses to nothing beyond the brewery brand, ranked by
`rating_count` dominance (top ÷ runner-up within the matched brewery pool):

| dominance | rows | correct outcome |
|---|---|---|
| 326×, 20.19×, 15.22×, 11.97×, 7.52×, 5.89× | Primátor, Pilsner Urquell, Poličká, Aperol, Březňák, Blue Moon | flagship is right (Aperol is stopped by ABV) |
| 2.45× … 1.09× | Trzech Kumpli, Menabrea, Nieczajna, Maryensztadt, Cydr Dzik, Krakonoš, Frankies, Herrnbräu, Old Prague, Przetwórnia, Gościszewo, Friedenfelser, Holendr, Erl Bräu, **Kronenbourg (1.09×)** | no flagship exists; orphan is right |

Nothing lies between 2.45× and 5.89×. Row 196 sits at 1.09× — `1664` has 292 835 ratings against
`1664 Blanc`'s 269 076 — so it is not a flagship case at all, and no threshold that picks there is
picking on evidence.

Two rows clear the dominance bar but are stopped by ABV: Aperol (11.97×, 9 % vs 7 %) and
Mojito (4.35×, 5.9 % vs 11.5 %). The veto is load-bearing.

### 3. ABV-as-selector is used, but never where this rule touches

400 matched beers replayed live, recording every decision where ABV chose among more than one
candidate:

```
sample=400   ABV selected among >1 candidate: 32
  by site: {"pickByAbv": 32}
  at pickUniqueByAbv (the site this design changes): 0
```

All 32 sit at Stage 2a (`untappd-lookup.ts:406`), where an exact name key already matched. The rows
say why: `Zwanze 2026`, `Geuze Mariage Parfait (2020)`, `Forks of the Credit (2024)`,
`Barrel Aged Past Lords (2025)`, `May Hill 2024` — vintages of one beer, collapsed to one normalized
name, separated only by strength. Applying dominance there would orphan 19 of them and change one.

**Stage 2a keeps ABV as its selector. This design does not touch it.**

### 4. A wider rule was tried and refuted

Suppressing the approximate name stages whenever the target is bare-brand (the `isBareBrandName`
treatment, one layer up) is tempting: it would fix row 196 *and* 32117 in one condition. Measured on
600 matched beers, it takes away two correct matches:

```
1391  Goose Island Beer Co. / Goose IPA    -> 1353 Goose IPA        (stage 2a.5)
23207 Brewmen / Brewmen Stout              -> 4472578 Brewmen Stout (stage 2a.5)
```

Both are `brand + style word`, and `normalizeName` eats the style word, so the target collapses to
the brand although the shop named the product perfectly. This is precisely the trap `matcher.ts:206-209`
already warns about ("`Litovel Weizen`, `Murphy's Stout` … would also classify real beers as bare
and deny them the fuzzy stage"). The suppression is **rejected**; the design below never denies a
stage that can match on its own.

## The design

Two changes, one principle. Both need `rating_count`.

### 0. Carry `rating_count` through the search seam

`SearchResult` gains `rating_count?: number`. `parseAlgoliaResponse` and `parseHydratedBeer` populate
it from the Algolia record. It stays **optional**: `htmlSearch` (legacy relay) and
`web-fallback.ts:98` leave it undefined, and every rule below treats "no popularity" as "no
evidence" — never as zero, never as dominance.

Two named constants, both derived from §2 and reviewable in one place:

```
DOMINANCE_RATIO      = 5     // top must out-rate the runner-up by this much
FLAGSHIP_MIN_RATINGS = 1000  // and be a beer enough people have actually logged
```

`FLAGSHIP_MIN_RATINGS` exists because a lone candidate has infinite dominance by arithmetic. A
73-rating beer that happens to be the only hit is not a flagship; the correct flagships in §2 carry
36 240 – 625 400 ratings, and the rejected noise carries 73 – 1 448.

### A. At the one approximate pick site, dominance replaces ABV-as-selector

`untappd-lookup.ts:508-517` (the `pickUniqueByAbv` call at `:510`), the native near-name stage. Its pool is scored **approximately**, so a
tie there is not an equivalence class — it is an absence of evidence.

Today, with more than one candidate tied at the top score, `pickUniqueByAbv` returns the single
ABV-compatible one. Instead:

- more than one candidate: return the top by `rating_count` **only if** it out-rates the runner-up
  by `DOMINANCE_RATIO`, carries at least `FLAGSHIP_MIN_RATINGS`, and its ABV does not contradict the
  input; otherwise `null`;
- exactly one candidate: unchanged, including today's ABV-contradiction rejection.

ABV stops selecting here. Row 196: two candidates, 1.09× → `null` → honest orphan.

The other three `pickUniqueByAbv` call sites — identity aliases (`:486`), native name keys (`:495`),
brand remainder (`:525`) — are built on **exact** keys and keep today's behaviour, for the same
reason Stage 2a does.

### B. A terminal flagship stage for bare-brand targets

Reached only after every existing stage has missed, immediately before the final `typoRescue()`
(`untappd-lookup.ts:566`). Because it is terminal, **it cannot change any match that exists today** —
it can only convert an orphan into a match. That is a structural property, not a measurement.

It fires when the normalized target carries nothing beyond the input brewery's brand — the condition
stated on the *target the stages compare*, not on the raw name, because the raw-name form does not
even describe row 196. Then:

1. take the strongest non-empty pool in the existing precedence order — strict, else relaxed, else
   native, else brand — and never mix pools, so a weak brand hit never competes with a strict one;
2. rank it by `rating_count`; require `DOMINANCE_RATIO` over the runner-up and
   `FLAGSHIP_MIN_RATINGS` on the leader;
3. veto on ABV: if both the input and the leader carry an ABV and they differ by more than
   `ABV_TOLERANCE`, the stage yields nothing. A vetoed leader does **not** hand the decision to the
   runner-up — the flagship claim is about the leader or it is about nothing;
4. otherwise no match, as today.

### What the two changes do to the measured population

| row | today | after |
|---|---|---|
| 196 `Kronenbourg 1664` | wrong link to `1664 Blanc` | orphan (A) |
| 1 `Pilsner Urquell` | orphan | `Pilsner Urquell`, 20.19× (B) |
| 11933 `Blue Moon` | orphan | `Belgian White`, 5.89× (B) — the beer #417 is chasing |
| 32, 73 `Primator Weizen` | orphan | `Weizen`, 326× (B) |
| 29799 `Breznak` | orphan | `Březňák Světlý ležák` (A) — its two top-scored near-name candidates stand at 22.05×, so part A matches it before the terminal stage is reached |
| the remaining 23 bare-brand rows | orphan | orphan — 20 for want of dominance, 3 for want of any candidate |
| 34469 `Aperol`, 395 `Mojito` | orphan | orphan — dominance clears, ABV vetoes |

Net on the current slice: **one wrong link removed, five orphans matched.**

## Deliberately not in scope

- **The digit identity.** `1664` is deleted by `isNumericNoise`, which is why row 196 can only become
  an honest orphan here and not a correct match. Restoring it touches 2 571 beers carrying a digit
  token and is a normalization change that must be measured across the whole catalogue. Separate
  issue; `normalize.ts:137-140` already records the trade-off it will revisit.
- **A style veto.** Requested during design, deferred on evidence: shop style is present on only
  323 of 707 orphan rows and is free-form Polish/Czech (`Pszenica`, `Svetly`,
  `Svetlý Ležák / Jasny Lager`) against Untappd's `Wheat Beer - Witbier`, so it needs a cross-lingual
  vocabulary. On the measured set it would not have changed a single row — the ABV veto already
  stops Aperol and Mojito. It is also an interface change: `lookupBeer` receives no style today.
- **Stage 2a and the exact-key pick sites** (§3).
- **`matcher.ts`'s local `isBareBrandName` guard (#306).** The local catalogue has no rating counts,
  so it has no flagship signal to use.
- **32117 `Menabrea`.** It matches through the *single-candidate* branch, which this design leaves
  alone; 2.23× would not have saved it anyway. It stays a questionable match and stays on record.

## Verification

Written before the numbers are produced, so the result is evidence rather than narration.

**What would surprise me:**

- that any row in the 400-beer replay decides at `pickUniqueByAbv` after the change — §3 measured
  zero, so a non-zero count means the pools shift for a reason this design has not understood;
- that the terminal stage changes any already-matched beer — it is unreachable for them by
  construction, so a single one means the stage is not actually terminal;
- that `rating_count` is missing on Algolia hits that carry `rating_score` — §1 saw it on every hit,
  and a gap would mean dominance silently degrades to "no evidence" on live traffic;
- that Blue Moon (5.89×) lands on the wrong side of a 5× bar after the pools are rebuilt in code —
  it is the closest correct row to the threshold and therefore the one that pins it.

**Instruments:** unit tests pinning each row in the table above by its measured candidate list;
a replay of the 33 bare-brand orphan rows before and after; the 400-beer matched-set replay re-run
to confirm the site breakdown is unchanged.

**In production, after deploy:** re-arm the five rows in the table and confirm they match to the
listed bids, then confirm row 196 comes back as an orphan and not as a link. Only then may #417 be
closed — the ordering is the whole reason this issue is first.
