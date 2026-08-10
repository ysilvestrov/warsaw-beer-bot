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
exactly one proper noun**, clamped so the name always retains at least one token.

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
`les`, `en`, `y`, `the`.

### 3.1 Accuracy against the catalogue

Both rules were replayed against **all 342 descriptor-led breweries** in the
`untappd_id IS NOT NULL` catalogue, by synthesising a title (`<brewery> <name tail>`) and
asking each rule to recover the brewery exactly:

| rule | exact recovery |
|---|---|
| today (`tokens.slice(0, -1)`) | 94 / 342 — **27%** |
| bounded (this design) | 236 / 342 — **69%** |

### 3.2 The direction of the residual error matters

The bounded rule's 106 misses all fail by producing a **shorter** brewery
(`Brouwerij De Halve Maan` → `Brouwerij De Halve`), leaving the surplus tokens at the head
of the name — the shape `stripBreweryFromName` already tolerates, and the shape the issue's
own probe showed to be survivable.

Today's rule fails by producing a **longer** brewery, which is the shape that produced the
single measured MISS. The bounded rule cannot produce a one-token name at all, so that
failure mode is eliminated by construction rather than by tuning.

All seven titles from the issue's probe split correctly under the bounded rule, including
the one that fails today.

## 4. Implementation

One new helper in `extension/src/sites/beerfreak.ts`:

```ts
// Index where a descriptor-led brewery ends: the descriptor, its run of
// grammatical qualifiers, then one proper noun — clamped so the name keeps
// at least one token. Callers pass tokens whose [0] is a known descriptor.
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

### 4.1 Empty brewery

The bounded rule always yields `end >= 2`, so this branch cannot emit an empty brewery.
The pre-existing `tokens.length < 2` fallback (`{ brewery: '', name: title }`) is left
alone: it is the single-token-title case, unreachable from this branch.

## 5. Tests

Vitest, alongside the existing beerfreak tests.

**Negative test, required by the issue** — today's behaviour must not change:
- `Browar Kormoran Orkiszowe` → `Browar Kormoran` + `Orkiszowe`

**Corrections:**
- `Brasserie du Bocq Blanche de Namur` → `Brasserie du Bocq` + `Blanche de Namur`
- `Birrificio Del Ducato Verdi Imperial Stout` → `Birrificio Del Ducato` + `Verdi Imperial Stout`
  (the measured MISS)
- `Brouwerij van Steenberge Gulden Draak 9000 Quadruple` → `Brouwerij van Steenberge` + tail

**Invariants:**
- the name is never empty and never a single token stolen from a longer name
- a two-token descriptor-led title (`Browar Kormoran`) keeps a non-empty name
- `stripCollaboratorName` on a descriptor-led collaborator title drops the brewery run,
  not a fixed two tokens

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
