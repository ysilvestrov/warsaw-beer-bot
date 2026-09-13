# #353 / #590 / #533 / #404 / #388 / #559 — Zero-hit retry for style descriptors and packaging tokens plan

**Date:** 2026-09-13  
**Status:** draft  
**Spec:** `docs/superpowers/specs/2026-09/2026-09-13-353-zero-hit-descriptor-retry-design.md`

## Task 1: `stripDescriptorAndPackaging` normalizer helper & unit tests

- **Files:**
  - `src/domain/normalize.ts`
  - `src/domain/normalize.test.ts`
- **Actions:**
  - Implement `stripDescriptorAndPackaging(rawName: string): string | null` in `src/domain/normalize.ts`.
  - Strip trailing packaging/volume tokens (`can`, `cans`, `bottle`, `bottles`, `pack`, `\d+-pack`, `keg`, `\d+ml`, `\d+cl`, `\d+l`).
  - Strip trailing style descriptors (e.g. `West Coast IPA`, `Foreign Extra Stout`, `Tomato Gose`, `niepasteryzowane`, `Pale Ale`, `Jasny lager`, `Malt Beer KVAS`, `hard seltzer`, etc.).
  - Return the stripped name if non-empty and different from `stripSearchNoise(rawName)`; otherwise return `null`.
  - Add comprehensive unit tests in `src/domain/normalize.test.ts` covering all target shapes from #590, #533, #404, #388, #559, #353.

## Task 2: Zero-hit descriptor retry & guards in `lookupBeer`

- **Files:**
  - `src/domain/untappd-lookup.ts`
  - `src/domain/untappd-lookup.test.ts`
- **Actions:**
  - In `src/domain/untappd-lookup.ts`, when `seenCandidates.length === 0`:
    - After the existing #271 `headBeforeTail` retry (or if not applicable), if `!descriptorRetried`, invoke `stripDescriptorAndPackaging(name)`.
    - If a non-null stripped name is returned, retry `lookupBeer` once with `{ ...args, name: strippedName }`, passing `descriptorRetried = true`.
  - When the retry returns `{ kind: 'matched', result }`:
    - Check alcohol-class guard: if input has `abv <= 0.7` or non-alcoholic keyword, reject candidate if `candidate.abv >= 2.0`. Conversely, if input has `abv >= 2.0` without non-alcoholic keyword, reject candidate if `candidate.abv <= 0.7` with non-alcoholic style.
    - Check ABV tolerance guard: if both `args.abv != null && result.abv != null`, ensure `|result.abv - args.abv| <= ABV_TOLERANCE`.
    - If either guard fails, reject the match and return `not_found`.
  - Add unit tests in `src/domain/untappd-lookup.test.ts`:
    - Zero-hit candidate rescue for style descriptors (`West Coast IPA`, `niepasteryzowane`, etc.).
    - Zero-hit candidate rescue for packaging tokens (`CAN`, `473ml`).
    - Alcohol-class guard test: input non-alcoholic rejects 6.0% twin (the #33783 regression test).
    - ABV tolerance guard test: input with differing ABV rejects candidate (the #33517 regression test).

## Task 3: Update `spec.md`

- **Files:**
  - `spec.md`
- **Actions:**
  - Document the zero-hit descriptor and packaging retry ladder and safety guards in §3.12 of `spec.md`.

## Task 4: Full gate & live adjudication probe

- **Actions:**
  - Run `npm test && npm run typecheck`.
  - Run live probe using `DOTENV_CONFIG_PATH=.env DATABASE_PATH=/var/lib/warsaw-beer-bot/bot.db npm run adjudicate -- --issue 590` to verify live rescue.
