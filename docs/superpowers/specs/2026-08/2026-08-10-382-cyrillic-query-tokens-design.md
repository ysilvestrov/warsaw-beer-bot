# #382 — Cyrillic tokens in the Untappd search query: design

**Date:** 2026-08-10
**Status:** design approved, pending implementation plan
**Issue:** #382 (`matcher-bug`)
**Scope:** server only — `src/domain/normalize.ts`, `src/domain/untappd-lookup.ts`.
The relay path (`/enrich/candidates` → extension) is deliberately excluded and
filed separately as #391 (§7).

## 1. The reported bug

`foldToken` (`src/domain/normalize.ts:136`) folds a token to ASCII:

```ts
function foldToken(tok: string): string {
  return stripDiacritics(tok).toLowerCase().replace(/[^a-z0-9]/g, '');
}
```

A token written entirely in a non-Latin script folds to `''`, and both loops of
`cleanSearchQuery` then discard it:

```ts
if (!f || f.length < MIN_QUERY_TOKEN_LENGTH || …) continue;
```

`MIN_QUERY_TOKEN_LENGTH = 2` exists because Algolia does not match a one-character
token (#350). Applied to the *fold* rather than the *token*, it cannot tell "one
character" from "not written in Latin". `Ципа / Сидр Грушевий PERRY` reaches Algolia
as `PERRY`.

Of 101 active (`retired_at IS NULL`) `enrich_failures` rows carrying Cyrillic, **96
lose at least one token**.

## 2. What the live replay changed about the diagnosis

Per project policy the issue's examples were replayed against the live builder and
the live Untappd Algolia index before any code was written. Three findings
overturned the issue's own direction.

### 2.1 The Untappd index is fully Cyrillic-capable

| query | nbHits | top hit |
|---|---|---|
| `Вирій` | 2 | **Вирій — Блукач** |
| `Ципа` | 360 | Ципа Пломбір (Plombir) — Ципа - Tsypa Brewery |
| `Сидр Грушевий` | 26 | Грушевий сидр — Private Gardens |

Preserving a Cyrillic token is therefore worth doing: the target records exist under
their Cyrillic names.

### 2.2 The issue's cheapest option is refuted

Algolia ANDs every term. Replaying all 101 rows through both candidate fixes:

| variant | rows improved | rows regressed (hits → 0) |
|---|---|---|
| **Option 1 of #382** — script-aware retention gate, keep every Cyrillic token | 16 | **44** |
| Curated Cyrillic noise vocabulary (stop words, shop labels, styles, grocery nouns) | 9 | **29** |

No static filter can succeed here. The tokens that zero the query are not noise —
they are real Ukrainian beer names (`Банановий Стаут`, `ІСКРА`, `Захцянка`,
`Спалах`, `КОМПОТКА`, `Чорний Ліс`) whose Untappd record happens to be registered
under a Latin or English name. Whether a given Cyrillic token exists in the index is
knowable only *from* the index.

### 2.3 A second mechanism the issue does not name: homoglyphs

- `Блукач / Вирій NEІРА` — `NEІРА` is `NEIPA` with Cyrillic `І`, `Р`, `А`. The
  token survives the fold by accident (its Latin `N`+`E` clear the 2-char bar) and
  sends a query that matches nothing.
- `Malle / Belgian Сhristmas Ale` — a Cyrillic `С`. Algolia **does** return the
  right beer, and the matcher still rejects it, because
  `normalizeName('Belgian Сhristmas Ale')` yields `belgian сhristmas ale` while the
  candidate yields `belgian christmas ale`. This is a matching defect, independent
  of query construction, and no amount of token preservation fixes it.

A census of mixed-script tokens over the whole catalogue (31942 `beers` rows) found
**33 distinct tokens**, small enough to enumerate as a test corpus:

- **12** have every Cyrillic character in the homoglyph set, and all 12 repair
  correctly toward Latin: `Companу`(×5), `Сherry`, `Сider`, `Coоkies`, `СOMMA`,
  `Soаked`, `TOMATO+Сhipotle`, `СINNAMON`, `СOCORITA`, `СITRA+CITRA`, `Сhristmas`,
  `NEІРА`. There is no counter-example wanting the opposite direction.
- **11** are the mirror case — a Cyrillic word carrying a Latin character in place
  of its Cyrillic twin, almost always `i` for `і`: `Свiтле`(×3),
  `Проскурiвське`(×2), `ИмбирьOK`, `(Зiберт`, `Aваддон`, `Вiд`, `Класiчнае)`,
  `Премiум)`, `(Львiвське`, `Бiлий`, `Рiздв'яний`.
- **10** are genuinely mixed and must stay untouched: `BeerЛога`(×2), `Hellь`(×2),
  `CowКава`, `Mozaїка`, `Enкel`, `ZЁZЯ`, `ЭльFan`, `NEЗагравай`, `миcola`,
  `Trymaysя!`.

The partition is produced by the rules in §3.1, not assigned by hand; the
implementation must reproduce it exactly.

## 3. Design

Three units, each independently testable.

### 3.1 `repairHomoglyphs(s: string): string`

Token-level repair, applied only to tokens containing **both** Latin and Cyrillic
letters. Two guarded rules, Latin taking precedence:

1. If every Cyrillic character in the token has a Latin homoglyph → map them to
   Latin.
2. Otherwise, if every Latin character has a Cyrillic homoglyph → map them to
   Cyrillic.
3. Otherwise return the token unchanged.

Latin precedence is not a tie-break heuristic; it is what the census requires.
`NEІРА` is Cyrillic-majority (3 vs 2) yet wants Latin, so a majority rule would
produce `НЕІРА`. Rule 1 first gives `NEIPA`.

The homoglyph map is deliberately conservative — only visually identical pairs:

```
А В Е К М Н О Р С Т У Х І Ј Ѕ  ↔  A B E K M H O P C T Y X I J S
а е о р с у х і ј ѕ            ↔  a e o p c y x i j s
```

Lowercase `к м т в н` are excluded: they are not reliably confusable with
`k m t b h`. The exclusion costs one legitimate repair in the whole catalogue
(`Enкel` stays as-is) and prevents a false one: including `в→b` would turn
`CowКава` into `CowKaba`.

**Call sites:**

- `baseNormalize` — so `normalizeName`/`normalizeBrewery`, and through them the
  name keys, the fuzzy targets and the brewery gate, all see the repaired form.
  Applied to both the input and the candidate side, so the transform is symmetric.
- The head of the query builder (§3.2), on the raw brewery and name, so the emitted
  query carries the repaired token.

### 3.2 `searchQueryLadder(brewery, name): string[]`

The query builder's pipeline is unchanged except for the fold used to decide
**retention**, **dedup** and the **leading/trailing echo strip**:

```ts
const unicodeFold = (tok: string) =>
  stripDiacritics(tok).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
```

`MIN_QUERY_TOKEN_LENGTH = 2` still applies — #350's rationale (Algolia does not
match a one-character token) is script-independent. It simply becomes script-aware:
`Шо` measures 2, not 0.

This also resolves the second-order effect named in #382: `brandFolds` can now
distinguish two Cyrillic tokens, so the brewery-echo strip (#126/#155) and the
dedup stop being blind on Cyrillic names.

The function returns the rungs, narrowest first:

```
[full, reduced]   when they differ
[q]               when they are identical
```

`reduced` is exactly today's `cleanSearchQuery(brewery, name)`. For an all-Latin
input the two rungs coincide, so the catalogue's Latin majority sees no ladder and
no extra cost.

**`cleanSearchQuery` itself is not modified.** `triage-probes.ts` and
`api/routes/enrich.ts` keep calling it and keep behaving exactly as today.

### 3.3 `lookupBeer` integration

Inside the existing `for (const part of parts)` loop, iterate the rungs of
`searchQueryLadder(part, name)`:

- Push every attempted URL onto `triedUrls`, so `enrich_failures.search_url`
  reflects what was really tried.
- Advance to the next rung **only when the search returns zero results**. A
  non-empty narrow rung is never abandoned — that rule is what makes the change
  safe (§4).
- When the last rung is also empty, `continue` to the next brewery part, as today.
- Block and transient error handling is unchanged and applies per rung.

## 4. Why this cannot regress

The full rung's term set is a superset of the reduced rung's, so its result set is a
subset. Falling back only on zero results means the pipeline either sees a strictly
narrower pool or exactly today's pool.

The theoretical gap in that argument is `hitsPerPage = 5`: a narrower pool could
return five wrong rows where today's top five happened to contain the right one.
That surface — beers that **currently match** — was measured directly, since the
issue's own examples are all existing failures and cannot show it.

Sample of 118 drawn from the 1626 matched beers carrying Cyrillic (1534 of which
get a different query under the ladder):

| outcome | rows |
|---|---|
| narrow rung returns the known-correct `untappd_id` in its top 5 | 116 |
| narrow rung empty → safe fallback to today's query | 2 |
| **known-correct id lost that today's query found** | **0** |

## 5. Acceptance criteria

1. `repairHomoglyphs` reproduces the §2.3 census exactly: the 12 Latin-direction
   and 11 Cyrillic-direction tokens repair as listed, and the 10 genuinely mixed
   tokens come back byte-identical. All 33 belong in the test corpus — the
   untouched ones are the negative guard.
2. `normalizeName('Belgian Сhristmas Ale') === normalizeName('Belgian Christmas Ale')`.
3. `searchQueryLadder` returns a single rung for all-Latin input, and its last rung
   always equals `cleanSearchQuery(brewery, name)`.
4. `lookupBeer` issues the reduced rung only after the full rung returns zero
   results, and issues it never when the full rung returns any result (assert the
   search call count, not just the outcome).
5. Replaying the 101 active Cyrillic failure rows after implementation reproduces
   §2.2's ladder column: ≥16 rows narrowed, 0 rows regressed.
6. `spec.md` updated: the query-construction rules now include homoglyph repair and
   the two-rung ladder.

## 6. Post-deploy operations

- Re-arm the affected orphans so the backlog is actually re-queried; the fix does
  nothing for a row that is never looked up again.
- Reclassify rows **30682** (`Дідько Brewery / Cute Cute Cute`) and **30001**
  (`SHO Brewery / Шо Золотко`). Both are filed `not_on_untappd`, and both are in
  fact on Untappd — the crippled query is what made the triage model conclude
  otherwise. Worth a note on #381: a wrong query produces a wrong triage class, not
  only a wrong result.
- Of the 55 flasker rows filed `parser_bug`, 22 are this bug and should leave the
  extension's 0.14 backlog once re-armed.

## 7. Out of scope

- **Relay path.** `/enrich/candidates` hands the extension exactly one prepared
  query, so a ladder there needs a protocol change (a second field plus a
  client-side fallback) and an extension release with its own version, changelog
  and `docs/extension-install-uk.md` review. Filed as **#391**. The homoglyph repair
  in §3.1 still reaches the relay path, because the relay's query also comes from
  `cleanSearchQuery`, and the matcher runs server-side.
- **Transliteration** (#320). `Банановий Стаут` is registered on Untappd as
  `Banana Stout`; no preservation rule finds it. The ladder is the complement to
  that work, not a substitute — and after this change a transliterated attempt is a
  natural third rung.
- **Grocery rows.** A large share of the Cyrillic backlog (sausages, sponges,
  candles, napkins from the ontap/winetime feeds) is not beer and should never have
  entered the catalogue. Counting them inflates the headline; they are not a
  matching problem.
