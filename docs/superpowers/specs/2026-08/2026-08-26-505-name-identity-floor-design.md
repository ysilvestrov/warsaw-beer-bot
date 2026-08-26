# #505 — the token filter may not leave a name without identity

Date: 2026-08-26
Status: agreed
Issues: #505 (supersedes #482 — bare style-word names; and #504 — digit names)
Related: #487 / `docs/superpowers/specs/2026-08/2026-08-25-487-flagship-dominance-design.md` (the
same failure family one stage over: when the name signal is gone, some other property is promoted
to identity), #306 (`isBareBrandName` — the local matcher already refuses to attach an arbitrary
product of a brewery), #321 (Czech grade: `10`/`12` is a style marker, not a name), #295 (query
noise from year and period tokens — the reason digit stripping is aggressive today), #465 (the
admit-side twin: a bare brewery alias accepted when the name normalizes to empty — deliberately
separate), #476 (brewery typo — the real blocker on row 239)
Measured from: production `bot.db` on 2026-08-26 (681 live orphan rows, 31 371 matched beers,
32 086 catalogue names) and live Algolia replays the same day, against `main` = `c397cb5`

## The model

> A beer name is a claim about identity. The token filter exists to strip the parts of that claim
> which are *not* identity — the style, the strength label, the vintage. It is allowed to remove
> noise. It is not allowed to remove the last thing that says which beer this is.

Today the filter has no such floor. `normalizeName` is one `.filter()` chaining four predicates
(`src/domain/normalize.ts:166`), and when they between them consume every identity-bearing token,
the name silently becomes `""` — or, worse, becomes the brewery brand, which then matches every
product that brewery makes.

The fix is not to strip less. It is to make the stripping **conditional on there being something
left**, and to remember that what got put back is weaker evidence than what was never removed.

## Why this is one defect and not two

`#482` reported the `STYLE_WORDS` predicate emptying a name. `#504` reported `isNumericNoise` doing
it. They are the same line of code:

```ts
.filter((t) => t && !STYLE_WORDS.has(t) && !SPEC_LABEL_WORDS.has(t) && !isNumericNoise(t));
```

Three facts settled it, all measured over the 32 086 catalogue names:

1. **227 names are emptied outright**, and the blame splits `style` 147, `digit` 49,
   **`digit+style` 26**, `digit+spec` 3, `digit+spec+style` 1, plus one name (`??? (Question
   Marks)`) that no predicate touches. The intersection is the third-largest
   bucket, and *neither* issue alone can fix it — fix style, the digits still empty the name; fix
   digits, the style words still do.
2. **A third predicate, `SPEC_LABEL_WORDS` (`alc`/`abv`/`ibu`), does the same** and had no issue at
   all. A per-predicate framing would have left a third mine in place.
3. **Both issues had independently found both shapes.** #482: "what survives is the brewery echo".
   #504: "reduce to the bare brand **or** to nothing". One rule, written twice.

The canonical witness exercises all three predicates in a single name —
`Southern Brewing & Winemaking / 300 IBU IPA` (bid 212077): `300` digit, `IBU` spec, `IPA` style,
`normalizeName` → `""`.

### It costs precision, not only recall

`Mikkeller / 0 IBU` and `Mikkeller / 1000 IBU` are different beers, same brewery, same ABV (12.1),
and both normalize to `""`. Nothing in the matcher can separate them. That is the silent-wrong-link
family #487 just closed, not merely a missed match.

## The rule

Identity is computed **brewery-aware**, because shape B (`Kronenbourg 1664` → `kronenbourg`) is
invisible to any test that only asks "is the string empty".

```
identity(name, brewery):
    filtered := normalizeName(name)
    if filtered carries a token that is not a brewery token:
        return stripBreweryFromName(filtered, brewery), restored = false
    unfiltered := baseNormalize(name)
    if unfiltered carries a token that is not a brewery token:
        return stripBreweryFromName(unfiltered, brewery), restored = true
    return stripBreweryFromName(filtered, brewery), restored = false   # nothing to recover
```

The rule is **self-limiting**: the fallback fires only where the filtered form has nothing left to
lose. It therefore cannot disturb the cases the filter was built for.

```
Kronenbourg 1664       -> no identity -> restored "1664"
1664                   -> no identity -> restored "1664"        -> match
1664 Blanc             -> "blanc" survives -> NOT restored      -> correctly no match
Buzdygan Rozkoszy IPA  -> filtered "buzdygan rozkoszy" survives -> #482's constraint held
                          (both sides then strip to "rozkoszy" and match, as today)
0 IBU / 1000 IBU       -> restored "0 ibu" / "1000 ibu"         -> finally distinguishable
```

### Restored identity is second-class evidence

A restored token is a style word, a spec label or a bare grade — precisely the noise the filter
exists to remove. Treating it as full identity is unsafe (measured below: 6 bad outcomes). So:

> When either side's identity was restored, an **exact** match between the two identities is
> accepted as-is; an **approximate** match must be corroborated by ABV within `ABV_TOLERANCE`.

This is the whole of the safety story, and it is why the naive form of this fix must not ship.

### The change must land on both sides at once

Measured by ablation over the four insertion points, on the 23 affected orphan rows:

```
input only            : gained 0, LOST 2      <- worse than doing nothing
input + candidate     : gained 2
  + near-name (2a.5)  : gained 4
  + relaxedExact      : gained 5
```

Input-only breaks rows 32/73 (`Primator Weizen`): the target becomes `weizen` while the candidate
stays `""`. **A partial rollout of this change is a regression**, which constrains how the plan may
be sequenced — no "input side first, candidate side in a follow-up".

## Insertion points

| site | file | what changes |
|---|---|---|
| input identity | `untappd-lookup.ts:67` (`fuzzyTargets`) | `stripBreweryFromName(normalizeName(raw), breweryNorm)` becomes the rule above; `FuzzyTarget` carries `restored` |
| candidate identity, near-name | `nearNameScore` candidate variants | add the restored identity to the variant set |
| candidate identity, fuzzy | stage 2b `keySelector` | key on identity rather than `normalizeName` |
| candidate identity, relaxed | `relaxedExact` | accept a restored-identity equality as well |
| corroboration gate | stages 2a.5 and 2b | the ABV rule above, applied when either side is restored |

`normalizeName` itself is **not** changed. It also feeds the search-query builder, and re-admitting
`2024` / `10°` there would re-poison queries — the failure #295 and #321 were built to prevent.
`nameKeys` is **not** changed either: measured, a single-token restored identity is served by the
existing non-key stages, so the `toks.length < 2` weak-key rule can stay exactly as it is.

## Evidence

Live Algolia, both variants served identical recorded candidates so the only difference is the rule.

**Target population — the 23 live orphans where the filter destroys all non-brand identity:**

```
23 rows | unchanged 18 | gained 5 | lost 0 | switched 0
```

Row 196 resolves to bid 5939 (`Brasseries Kronenbourg — 1664`) — the target #504 named — *even
though the shop's ABV of 5.0 points at `1664 Blanc`*. Also won: 30143 `Mahrs Bräu / Pils`,
30149 `Primator / Weizenbier`, 30201 `Święty Jan Pils` (#482's own single-variable proof),
34642 `PRIMÁTOR WEIZENBIER`.

The 18 unchanged rows are blocked by **named** defects that are not this one: the brewery typo
`Tennet`/`Tennent` (239), the degree marker `11,2°` (34852), the #306 bare-brand guard
(32646 `Holendr / Holendr`), and brewery-alias gaps (11957, 12081, 25821).

**Risk population — the 326 of 31 371 matched beers (1.04 %) where the fallback fires at all:**

```
192 land on the stored bid
  6 baseline WRONG links refused   (improvement)
  4 bad
  2 ambiguous
```

The 6 refusals are a bonus this design did not set out to buy: today's matcher links non-alcoholic
beers to their alcoholic namesakes — `Żywiec 0.0%` → `Żywiec` 5.5 %, `Okocim 0,0%` →
`Okocim Mocne Dubeltowe` 6.5 %, `Tyskie 0.0%` → `Tyskie Gronie` 5.2 %. The rule breaks those links,
because `0 0` is restored identity and no longer collapses to the bare brand.

Without the second-class-evidence refinement the same population produced **6 bad outcomes**:
`Wheat` → `We're Wheatly Sorry`, `IPA` → `IPALIT`, `Weizen` → a *different brewery*, and three
switches to a worse ABV. That number is the reason the refinement is part of the design and not an
optimisation.

## Open decisions — to be resolved in the plan, not deferred

These are the 4 bad and 2 ambiguous rows above. Each is named, with the direction it should take.

1. **12007 — `Nachmelená Opice / 11` @4.5 picks `Session IPA 11%` @4.7 over `Ležák 11%` @4.5.**
   A bare Czech grade is not identity. `extractGrade` (#321) already recognises this shape;
   a restored identity that is *only* a grade must not be treated as identity at all.
2. **31180 — `Броварня #8 / Weizen` matches `Броварня Кружак — Weizen`, a different brewery.**
   Restored identity must require a **strict** brewery. Note this was attempted and NOT measured
   during design: the trial threaded no pool tag and only removed `relaxedExact`, which cost one
   win. The plan must thread the strict/relaxed pool tag properly and re-measure.
3. **32598 — `Lambic Boon` @4 matches `Unblended Oude Lambiek` @7.**
   The ABV corroboration did not reach the stage that accepted this. Find which stage and extend the
   gate; a 3 % ABV gap must never survive on restored evidence.
4. **30272 — `Tyskie Lager` @4.6 becomes a refusal instead of the correct `Tyskie Sport Lager`.**
   The one genuine loss among 326. Decide explicitly whether it is acceptable collateral or needs a
   carve-out; do not let it pass unremarked.
5. **3018 — `CRAK Brewery / NEIPA (2020)` matches the year-less `NEIPA`.**
   The vintage risk #504 predicted. `extractYear` reads the *un-normalized* name precisely because
   digits are stripped; once a digit can be restored, the vintage partition sees a different world.
   The plan must state what the partition does with a restored token.
6. **4760 — `Imperial Porter` @10 picks bid 2576506 where 2576509 is stored.** Adjacent sibling
   entries, same name, same ABV. Establish whether this is a real error or catalogue duplication.

## Rejected, with the measurement

**Excluding one-character tokens from the identity test.** Motivated by the apostrophe artifact
(`Tennent's` → `tennent s`), it produced *identical* numbers on both populations — 5 gained on the
orphans, 12 disagreements on the risk set. Row 239's real blocker is the brewery typo
`Tennet`/`Tennent` (the brewery gate itself passes, measured `strict=true`), and 29561 needs
`IPA` = `India Pale Ale`. A variant that excluded one-character tokens *including* digits was
actively worse: it reverted the non-alcoholic `0,0%` fixes, because `0` is one character.

**Changing `normalizeName` itself**, and **changing `nameKeys`** — both covered above.

## Testing

- **Mutation-prove every guard.** For each of the three predicates, a test whose name claims a
  branch must fail when that branch is deleted. #487 shipped a test that named a branch it never
  reached because sorting hid it; demand "delete the line, show the test go red".
- **The witness `300 IBU IPA` gets a test of its own** — it is the only single name that exercises
  all three predicates at once, so it is the regression guard against a future per-predicate fix.
- **A both-sides test.** Because input-only is a measured regression, there must be a test that
  fails when only one side applies the rule — rows 32/73 are the witness.
- **A restored-evidence safety test** per bad outcome above: `IPA` must not reach `IPALIT`,
  `Wheat` must not reach `We're Wheatly Sorry`, `Weizen` must not cross a brewery.
- **The self-limiting property**: `Buzdygan Rozkoszy IPA` → `Buzdygan Rozkoszy` and
  `1664 Blanc` ≠ `1664` must both stay green; they are what proves the fallback never fires where
  something survives.
- Re-run both replay populations before merge and reconcile every number that moved.

## Rows

#505 owns 7 rows (remapped 2026-08-26, `review_class` untouched): 196 (from #417), 30143 (#334),
30149 + 30201 + 239 + 29561 (#482), 34642 (#322). Five are measured wins. **239 and 29561 are
knowingly not covered** — they sit here as the successor's custody, not as a claim, and will each
cost one retry when this issue closes.

## Deliberately not in scope

- **#465**, the admit side of the same notion of an empty name — different code, opposite direction
  of error, different success criteria.
- The brewery typo (#476) and the `IPA` / `India Pale Ale` style-synonym gap.
- Rows 32 and 73: today's matcher already matches them live; their `enrich_failures` rows are stale
  and will self-clear on retry.
