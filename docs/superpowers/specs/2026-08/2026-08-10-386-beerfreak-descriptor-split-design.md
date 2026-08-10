# #386 — bounding the beerfreak descriptor-led brewery split: design

**Date:** 2026-08-10
**Status:** design approved, pending implementation plan
**Issue:** #386 (`extension-bug`, `parser-bug`)
**Scope:** `extension/src/sites/beerfreak.ts` only, plus its tests. No server change,
no schema change, no change to any other adapter.
**Deliberately out of scope:** the catalog-backed statistical splitter (filed separately —
see §6). This design is the small, adapter-local half.

## 1. The defect

When beerfreak's embedded product metadata has `brand_title: null`, the adapter falls back
to `splitBrandlessTitle`. If the title's first token is a brewery descriptor (`brasserie`,
`browar`, `brouwerij`, `pivovar`, `birrificio`, `brauerei`), that branch assigns **every
token but the last** to the brewery:

```ts
// extension/src/sites/beerfreak.ts:130-136
if (tokens.length >= 3 && first && LEADING_BREWERY_DESCRIPTORS.has(first)) {
  return { brewery: tokens.slice(0, -1).join(' '), name: tokens[tokens.length - 1] };
}
```

`Brasserie du Bocq Blanche de Namur` → brewery `Brasserie du Bocq Blanche de`, name
`Namur`. Correct is `Brasserie du Bocq` / `Blanche de Namur`.

The same file carries the **opposite** assumption at `beerfreak.ts:94`, where a
descriptor-led collaborator title is treated as brewery = the first **two** tokens
(`tokens.slice(2)`). Both are hard-coded guesses at the same quantity, and they disagree.

## 2. What it actually costs

Measured in the issue, not assumed. Seven realistic descriptor-led titles were matched
against catalogue rows holding the correct brewery/name: **six of seven still match** under
the mis-split, because `stripBreweryFromName` tolerates the brewery bleeding into the name.
The seventh fails — `Birrificio Del Ducato Verdi Imperial Stout`, where the stolen tokens
leave the name as the bare style word `Stout`.

The search query is unaffected in all three splits (`Brasserie` is stripped as brewery
noise), and emitting an **empty** brewery is strictly worse than a wrong-but-overlapping
one: every beerfreak row currently carrying an empty brewery is an unmatched orphan
(29481, 29482, 29507, 29509, 29510, 29511 — six for six).

So the cost is: one matching-failure shape (name collapsed to a single token), plus
catalogue hygiene — a brewery that does not exist is what users see, what the triage agent
reads when it classifies the row (#381), and what seeds junk brewery identities into
`beers` (#282).

## 3. The rule, chosen from data

Candidate rule: the brewery is **the descriptor + its run of grammatical qualifiers +
one proper noun + a trailing run of brewery-descriptor words**, clamped so the name always
retains at least one token.

The trailing run is not decoration: `Brouwerij De Dolle Brouwers` is covered by an existing
test (`beerfreak.test.ts:175`), and without it the rule would cut that brewery to
`Brouwerij De Dolle`. Attested trailing words in the catalogue: `brewery` (31 breweries),
`brewing` (2), `brouwers` (1), `co.` (1), `brasserie` (1).

The qualifier list is derived from the catalogue, not invented. Over the 3+ token
descriptor-led breweries with `untappd_id IS NOT NULL`, the second token is:

| token | distinct breweries |
|---|---|
| `de` | 33 |
| `du` | 7 |
| `het` | 5 |
| `la` | 4 |
| `'t` | 4 |
| `van` | 3 |
| `des` | 3 |

plus singletons `del`, `della`, `dei`, `di`, `da`, `der`, `den`, `von`, `l'`, `d'`, `le`,
`les`, `lo`, `en`, `y`, `the`, and the Polish prepositions `na`, `za`, `w` (attested by
`Browar na Jurze`, `Browar Za Miastem`).

### 3.1 Accuracy against the catalogue

Both rules were replayed against **all 342 descriptor-led breweries** in the
`untappd_id IS NOT NULL` catalogue, by synthesising a title (`<brewery> <name>`) and asking
each rule to recover the brewery exactly. The result is reported **conditioned on how many
tokens the beer name has**, because today's rule is a pure function of that:

| rule | 1-token name | 2-token name | 3-token name |
|---|---|---|---|
| today (`tokens.slice(0, -1)`) | 342/342 — **100%** | 0/342 — **0%** | 0/342 — **0%** |
| bounded, no trailing run | 239/342 — 70% | 239/342 — 70% | 239/342 — 70% |
| bounded + trailing run (this design) | 266/342 — **78%** | 266/342 — **78%** | 266/342 — **78%** |

Today's rule is correct only when the beer name happens to be exactly one token, and wrong
otherwise — it never reads the brewery, it assumes the name is one word. The bounded rule is
independent of the name length, which is the property that makes it usable at all.

An earlier draft of this design reported 27% vs 69%. Those numbers were an artefact of
mixing name lengths in one harness run; the table above supersedes them. The conclusion is
unchanged and stronger.

### 3.2 The direction of the residual error matters

At a 2-token name the bounded rule's 76 misses are **all** too short
(`Brouwerij De Halve Maan` → `Brouwerij De Halve`) and **none** too long. Surplus tokens
stay at the head of the name — the shape `stripBreweryFromName` already tolerates, and the
shape the issue's own probe showed to be survivable.

Today's rule is the mirror image: at a 2-token name all 342 are too long. That is the shape
that produced the single measured MISS.

**The "never too long" property is a property of the trailing set, not of the rule.** An
earlier draft claimed the bounded rule "cannot produce a one-token name at all… eliminated by
construction". Review refuted that: the trailing-descriptor run can over-eat if it contains
words that are also beer-name words. With `family`/`company`/`co` in the run,
`Brasserie Dupont Family Reunion` split as `Brasserie Dupont Family` + `Reunion` — exactly the
failure shape the rule is supposed to remove.

That is why the trailing set is narrowed to structural brewery words only (§4). Measured:
dropping `family`, `company`, `co`, `co.` from the run costs **zero** accuracy — 266/342
either way — so the hazard is removable for free, and the "0 too long" column above holds for
the narrowed set. The honest claim is: too-long splits are possible in principle and are
excluded by keeping beer-name words out of the trailing set, which is a decision the tests
pin rather than a guarantee of the algorithm.

All seven titles from the issue's probe split correctly under the bounded rule, including
the one that fails today.

## 4. Implementation

One new helper in `extension/src/sites/beerfreak.ts`:

```ts
// Index where a descriptor-led brewery ends: the descriptor, its run of
// grammatical qualifiers, one proper noun, then a trailing run of brewery
// descriptors — clamped so the name keeps at least one token. Callers pass
// tokens whose [0] is a known descriptor.
function descriptorBreweryEnd(tokens: string[]): number
```

It replaces both hard-coded guesses:

| site | today | after |
|---|---|---|
| `splitBrandlessTitle` (~:130) | `tokens.slice(0, -1)` / `tokens[len-1]` | `tokens.slice(0, end)` / `tokens.slice(end)` |
| `stripCollaboratorName` (~:94) | `tokens.slice(2)` | `tokens.slice(end)` |

Routing the collaborator branch through the same helper is deliberate: it removes the
contradiction between the two sites, and adds no second concept. It does change behaviour
for descriptor-led collaborator titles whose brewery is not exactly two tokens — in the
same direction and with the same accuracy characteristics as §3.

`QUALIFIER_TOKENS` is a new module-level `Set` alongside the existing
`LEADING_BREWERY_DESCRIPTORS`, compared through the existing `normalizedToken`
(which lowercases and strips `(`, `)`, `,`).

The **trailing** run gets its own set, `TRAILING_BREWERY_TOKENS`:

```ts
const TRAILING_BREWERY_TOKENS = new Set([
  ...LEADING_BREWERY_DESCRIPTORS, 'brewery', 'brewing', 'brouwers',
]);
```

An earlier draft of this design reused the existing `BREWERY_DESCRIPTORS` set instead,
arguing "no third set". That was wrong, and review caught it: `BREWERY_DESCRIPTORS` contains
`family`, `company`, `co`, `co.`, which are ordinary beer-name words — see §3.2. The measured
justification for a separate set is that removing those four from the run costs nothing:

| trailing set | exact recovery (2-token name) |
|---|---|
| `BREWERY_DESCRIPTORS` (+`brouwers`) | 266/342 — 76 too short, 0 too long |
| `TRAILING_BREWERY_TOKENS` (this design) | 266/342 — 76 too short, 0 too long |
| no trailing run at all | 239/342 — 103 too short, 0 too long |

So the narrow set buys the same 78% with a strictly smaller hazard. `BREWERY_DESCRIPTORS` is
therefore left **unmodified**, and `stripLeadingBreweryRun` — its other consumer — is
untouched by this change.

`brouwers` earns its place in the trailing set on its own: it is attested by
`Brouwerij De Dolle Brouwers`, which an existing test pins (§5).

### 4.1 Empty brewery

The bounded rule always yields `end >= 2`, so this branch cannot emit an empty brewery.
The pre-existing `tokens.length < 2` fallback (`{ brewery: '', name: title }`) is left
alone: it is the single-token-title case, unreachable from this branch.

## 5. Tests

Vitest, alongside the existing beerfreak tests.

**Negative tests — today's behaviour must not change:**
- required by the issue: `Browar Kormoran Orkiszowe` → `Browar Kormoran` + `Orkiszowe`
- the **existing** test at `beerfreak.test.ts:175`:
  `Brouwerij De Dolle Brouwers Oerbier` → `Brouwerij De Dolle Brouwers` + `Oerbier`.
  This is what forced the trailing-descriptor run into the rule (§3); it must stay green
  unmodified, and it is the plan's canary for that clause.

**Corrections:**
- `Brasserie du Bocq Blanche de Namur` → `Brasserie du Bocq` + `Blanche de Namur`
- `Birrificio Del Ducato Verdi Imperial Stout` → `Birrificio Del Ducato` + `Verdi Imperial Stout`
  (the measured MISS)
- `Brouwerij van Steenberge Gulden Draak 9000 Quadruple` → `Brouwerij van Steenberge` + tail

**Invariants — each must be pinned by a test that goes red when its clause is deleted:**
- the clamp: `Brasserie de la Senne` → `Brasserie de la` + `Senne`. The rule runs out of
  title before it finds a proper noun, so the clamp alone decides the boundary. Asserting on
  the split (not on `parseCards` output) is required — `parseCards` drops empty-name cards and
  backfills the name from the raw title, so an "is not empty" assertion there is
  unfalsifiable. An earlier draft of this design specified exactly that unfalsifiable test;
  mutation testing caught it, with the clamp deleted and the suite still green.
- the trailing set's narrowness: `Brasserie Dupont Family Reunion` → `Brasserie Dupont` +
  `Family Reunion`, and `Browar Pinta Company Man` → `Browar Pinta` + `Company Man`
- `stripCollaboratorName` on a descriptor-led collaborator title drops the brewery run,
  not a fixed two tokens

**Mutation testing is part of the definition of done for this change**, not an optional
extra. Every clause of `descriptorBreweryEnd` — the qualifier loop, the proper-noun step, the
trailing loop, the clamp — and each contested set member must have a test that fails when it
is removed.

## 6. Relationship to the splitter issue

The 31% the bounded rule cannot recover needs the brewery to be *known*, not guessed —
`Brouwerij De Dochter van de Korenaar` is not derivable from grammar. That is a
catalogue-dictionary problem, it applies to every adapter rather than to beerfreak, and it
can run server-side where the catalogue lives (so it reaches already-installed 0.13.0
clients). It is filed as its own issue with its own measurements and gets its own spec.

This design does not depend on it, and it does not depend on this design.

## 7. Release

The fix rides in extension **0.14.0** with the already-merged #383/#385/#384 work.
It needs a `CHANGELOG.md` entry. It does **not** touch `docs/extension-install-uk.md`:
no new shop, option, popup control, badge, or install/update flow (per CLAUDE.md, only
those categories require the install guide to change).
