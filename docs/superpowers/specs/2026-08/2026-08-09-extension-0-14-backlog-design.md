# Extension 0.14 — matching-quality release: backlog design

**Date:** 2026-08-09
**Status:** design approved, pending implementation plan
**Scope:** `extension/**` only. No new features.

## 1. Purpose and shape

0.14 is a matching-quality release: it fixes shop adapters so that beers which
should badge, badge. It adds **no** new shops, badges, options, popup controls or
permissions.

That constraint is not only a preference. A release with no new host permission and
no new user-facing surface passes Chrome Web Store review most quietly, and
`docs/extension-install-uk.md` needs no change — the CLAUDE.md documentation duty
fires on user-facing extension changes (new shop, option, popup button, new badge
behaviour, install flow), and this release has none.

Since 0.13.0 (2026-07-31, in the store) **no user-facing change has landed** in
`extension/`: the only commits are release tooling (#374 CWS upload automation,
#378 off-store channel retirement). The 0.14 changelog therefore starts empty and
this backlog defines the whole release.

### Baseline: active orphan failures per shop

Production, `retired_at IS NULL`, 2026-08-09:

| shop | total | classed `parser_bug` |
|---|---|---|
| **flasker** | **139** | **55** |
| beerfreak | 32 | 11 |
| winetime | 26 | 0 |
| beerrepublic | 21 | 2 |
| funkyshop | 16 | 4 |
| onemorebeer / piwnemosty / bierloods22 | 6 / 2 / 2 | 0 |

## 2. The rule that governs this release

**Only proven-live defects enter 0.14.** For every candidate class we first show
that today's shipped adapter still reproduces the defect. Anything not proven goes
to one of two other outputs, and the three must never be mixed:

1. **Extension code** → 0.14.
2. **Dead rows** (defect already fixed, row never retired) → a retire batch in
   production. Ops, not release.
3. **Non-parser findings** (the defect is server-side) → matcher issues / #381.
   Out of 0.14 entirely.

This rule exists because the orphan table systematically **overstates** the work.
Two independent demonstrations on 2026-08-09: 24 onemorebeer rows were merch and
soft drinks the adapter already rejects (retired), and 4 of ~10 suspected
cross-adapter leaks turned out to be already handled by shipped code.

## 3. Verification gate

The question per class is always: *does today's adapter still produce this row?*
The method differs, and choosing the wrong one produces a false answer.

### 3.1 Cheap pass — title reconstruction

For text-only classes (non-beer gates, banner prefixes, brewery echo) rejoin
`brewery + ' ' + name` into a head and run it through the adapter's live
predicate. Deterministic, offline, unit-testable. This is how the 4 dead
cross-adapter rows were identified.

### 3.2 Not sufficient for the flasker registry

`resolveBreweryRule(evidence)` reads `productTags` and the brand strip from the
DOM (`extension/src/sites/flasker.ts:225-244`). A reconstructed string has neither,
so the cheap pass returns a **false negative** — it reports a leak where the real
page would resolve the brewery from a tag. The registry class (the largest item)
therefore requires a live capture and a real `parseCards` run.

### 3.3 Third outcome: not reproducible

The product may simply be delisted. Such a row can never resolve on its own, but
`retire` formally asserts "the responsible fix shipped", which would be false.
These get their own retire reason — *"no longer listed; cannot reproduce"* — so the
record stays honest. Same caution as declining to write `wontfix` on kombucha.

## 4. Backlog

### 4.1 Proven live — work, no further verification

**F1 — banner prefix poisons the brewery field (ordering defect).**
`stripMerchandisingPrefix` exists since 0.10.0 but runs on the **name, after** the
split (`flasker.ts:245`). When no registry rule matches, `splitBreweryName(head)`
takes the first word of the *raw* head — `ПРЕДРЕЛІЗ` — as the brewery, and the strip
then cleans a remainder that no longer contains the prefix. This is why row 34198
leaked in August despite the regex existing.

*Fix:* strip the banner from `head` **before** the split / registry lookup.
*Rows:* 29780, 29795, 29898, 29912, 34198. Two of them (`ПРЕДРЕЛІЗ: DE ZWARTE
REGEL: …`) should additionally start resolving through the registry once the banner
is gone, closing two classes with one change.
*Risk:* low, mechanism read directly in the live path.

**F5 — ambiguous soft-drink families, ABV-gated.**
`Doze energy drink zero` and `Old Jamaica Ginger Beer Regular` pass every current
gate (verified). But a name blocklist would be wrong: ginger beer and root beer are
beers **when they contain alcohol**.

A pure `abv == 0 ⇒ not beer` rule is also forbidden, and this is load-bearing:
`extension/src/shared/abv.ts` states that 0 is a legitimate value and is the only
thing separating AleBrowar Kwas Chlebowy Bright (0.0%) from Light (0.5%) — the
feature shipped in 0.13.0. Alcohol-free beer is beer and is on Untappd.

*Rule:* the **name or the shop-published style** matches an ambiguous soft-drink
family (`ginger beer`, `root beer`) **AND** ABV is 0 ⇒ not beer. `energy drink` is
unambiguous and needs no ABV gate.

The ABV gate is scoped strictly to that family and carries no meaning outside it:
"ginger beer" and "root beer" are simply the names English gave to two
non-fermented soft drinks, while alcoholic versions of both exist and are on
Untappd. Alcohol-free **beer** (kvass, 0.0% lagers) is untouched by this rule — it
never matches the family in the first place, and nothing here may be generalised
into "0.0% is not beer".

*Style availability:* `Card.style` is currently populated by **onemorebeer only**
(the "Dane techniczne" panel, #369); flasker publishes none, so both known rows are
decided by name + ABV today. The style surface is in the rule because it is the
correct signal and costs nothing, not because it changes the current two rows.
*When ABV is absent* (the four adapters that publish none on listings): **keep the
product**. A stray orphan is cheaper than silently hiding a real beer from the user.
*Evidence:* stored ABV is 0.0 for both rows; the Ципа ciders in the same batch carry
7.5 and are correctly kept.
*Rows:* 34205, 34211.

Proven work today totals **7 rows** — not a release on its own. Everything else
depends on the gate.

### 4.2 Gated — size unknown until the capture runs

| id | class | rows | gate |
|---|---|---|---|
| **F2** | flasker brand-registry gaps (`Copper \| Head`, `The \| Lost Philosopher`, `DE \| ZWARTE REGEL`, `Ten \| Men`, `Vovchansk \| Brewery`) | ~20 | live capture (§3.2) |
| **BF1** | BeerFreak collab slash residue + empty brewery (`PINTA \| /Folkingebrew`, `VARVAR BREW \| \Saugatuck`) | 7 | live capture |
| **BF2** | BeerFreak brewery echo (`HOPPY HOG BREWERY \| Hoppy Hog Family Brewery …`) | 2 | reconstruction |
| **FS1** | Funkyshop empty brewery | 3 | live capture |

F2, BF1 and BF2 are all classes whose fix was **already announced shipped** — 0.10.0
for Copper Head / Lost Philosopher / DE ZWARTE REGEL, 0.9.1 for the collab slash,
0.12.0 for the echo. Either the fix leaks on some path or the rows are dead. That is
exactly what the gate decides, and it must run before any code is written.

**F3 — series-header banner (`AOTEAROA:`, inverted `CITADEL \| Томатка`).**
Initially misjudged as trivial. A rule of the form "leading ALL-CAPS token followed
by a colon is a series header" would destroy `DE ZWARTE REGEL: Laatste Plicht`,
where that exact shape is a **real** brewery. Needs an evidence-built rule, not a
stop-list.

*Status in 0.14:* filed as an issue, **not** committed to the release. It enters
0.14 only if a rule can be built that provably leaves `DE ZWARTE REGEL: …` intact;
otherwise it defers. Do not let it hold up the cut.

### 4.3 F4 — investigated and closed: not an extension defect

The Cyrillic/mixed-script class (`Блукач | Вирій NEІРА`, `Rebrew | ІСКРА SIPA`,
`ШО (IIIO) | Спалах Tomato Gose`, `Ципа | Сидр Грушевий PERRY` / `… ROSE`).

**Method:** replay the five stored `(brewery, name)` pairs through the live server
query builder `cleanSearchQuery` (`src/domain/normalize.ts:200`) and compare against
the `search_url` recorded in production. No network needed.

**Result — all five reproduce exactly:**

| extension emitted | query actually sent |
|---|---|
| `Блукач` / `Вирій NEІРА` | `NEІРА` |
| `Ципа` / `Сидр Грушевий PERRY` | `PERRY` |
| `Ципа` / `Сидр з Брусницею ROSE` | `ROSE` |
| `ШО (IIIO)` / `Спалах Tomato Gose` | `Tomato Gose` |
| `Rebrew` / `ІСКРА SIPA` | `Rebrew SIPA` |

The extension supplied a correct brewery and name in every case. The Cyrillic tokens
are dropped **server-side**, in query construction.

**Consequences:** hypothesis (3) of #376 is refuted and must be corrected on the
issue; the class leaves 0.14 and becomes a matcher-side issue (adjacent to #320,
which covers Cyrillic↔Latin *folding* — this is Cyrillic token *dropping*, a
different mechanism); and it is a third same-day instance of `parser_bug` pointing at
the wrong codebase, which is the thesis of #381.

**Had it been an extension defect,** the fix would have belonged with F1 in the
flasker split path. It is not, so no extension work follows.

### 4.4 W1 — winetime detail-page ABV (#373), separate PR

Included in 0.14 by explicit decision, shipped as its own PR.

*Risk check:* `winetime.com.ua` is already in the manifest's `SHOP_MATCHES`
(`manifest.config.ts:26-27`), so detail fetches are same-origin and require **no new
permission** — store review stays quiet. The pattern exists:
`beerfreak.loadCardDetails`, capped at `MAX_DETAIL_FETCHES_PER_PASS = 20`,
promise-cached by URL, failures swallowed.

*Precondition (project policy, and demanded by #373 itself):* replay winetime's 22
candidate-bearing failures against live detail pages **before** implementing —
prove the detail page publishes an ABV *and* that the ABV changes the pick. If it
does not, the PR is not cut, and we know before writing code.

*Documentation:* no change to `docs/extension-install-uk.md`. BeerFreak has made
detail fetches since 0.9.1 and the guide documents only the Algolia enrichment;
breaking that precedent for winetime has no user value.

*Synergy:* this removes winetime's ABV blind spot, which is one of the cases where
F5's "ABV absent ⇒ keep" default has to guess.

### 4.5 Explicitly out of scope

- **#307** (flasker imports) — needs a curated server-side alias; the adapter cannot
  recover a brewery Flasker never publishes.
- **#280** (429 / Retry-After) — depends on server-side rate limiting landing first.
- **Retire batch** — ops, not release: BR 29210, BF 31072, BF 29993, FS 31136
  (proven already handled), plus whatever the gate proves dead.
- **The 5 rows with brewery `Flasker`** (`Банановий Стаут`, `ТРИмайся! Tripel`, …) —
  Flasker is a real Untappd brewer (confirmed on the Syrskald variants), so these are
  matcher-side, not parser. Feed #381.

## 5. Fixture capture automation

Fixtures exist for all 9 shops, but capture scripts exist only for flasker and
onemorebeer (`capture-flasker-fixture.ts`, `capture-omb-*.ts`); the rest were
captured by hand. The gate in §3.2 needs fresh captures for beerfreak, funkyshop and
flasker, so rather than adding two more ad-hoc scripts we consolidate.

**`extension/scripts/capture-fixture.ts`** — one config-driven tool (playwright is
already a dependency), replacing the existing ad-hoc scripts:

- **Target registry:** per fixture — URL, card selector, hydration strategy
  (`networkidle` or scroll-N-times, as onemorebeer needs), output filename.
- **Block-page guard:** refuse to overwrite when the rendered card count is 0, or
  below half the card count of the fixture being replaced (override with `--force`
  for a genuine shrink, e.g. a shop trimming its catalogue). Without this, a Cloudflare
  challenge silently replaces a good fixture with a useless one — ontap.pl already
  returns 403 to plain requests, so this is a live risk, not a theoretical one.
- **`--parse`:** run the freshly captured DOM through the shop's real `parseCards`
  and print the resulting `(brewery, name)` pairs. This is what turns the §3.2 gate
  from manual work into one command, and it is reusable for every future adapter
  investigation.
- **`--all` / `--list`:** re-capture everything; enumerate targets.

The existing per-shop scripts are removed once their targets are registered, so
there is one way to capture a fixture.

## 6. Release mechanics

**Order:** gate (captures + reconstructions) → retire batch for dead rows → code.
The PR list is therefore fixed *after* the gate, not now.

**PRs:** F1 + F5 together (both in `flasker.ts`, both proven); W1 separately; one PR
per surviving gated class. Every PR carries fixture-based unit tests plus a negative
test proving the neighbouring class did not regress — `DE ZWARTE REGEL` for F3,
Kwas Chlebowy 0.0% for F5 — and goes through the full AI review loop before merge.

**Cut:** bump `extension/package.json` to 0.14.0, write `extension/CHANGELOG.md` in
user language (not "fixed the split" but "more Flasker beers now get badges"), then
`npm run release:store` and submit. The off-store channel is retired (#378): no zip
broadcast.

**After deploy:** re-arm the orphans of every fixed class and measure. Without that
we cannot tell whether a fix worked, and a month from now we will be looking at the
same rows unable to say whether they are live or dead — the exact failure this
release is built to stop.

## 7. Open questions

None blocking. The gate resolves the only sizing unknown (F2/BF1/BF2/FS1), and its
outcome determines whether 0.14 ships as a substantial release or as a small one
built on F1, F5 and W1.
