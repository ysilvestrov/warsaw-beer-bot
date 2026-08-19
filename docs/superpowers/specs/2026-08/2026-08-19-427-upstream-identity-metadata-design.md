# Design: Preserve upstream identity evidence during Untappd matching

**Issue:** #427 — Brewery labels, collaboration credits, and brand-owner names
block otherwise valid matches

## Goal

Recover matches only when Untappd's Algolia result already carries structured
evidence that connects the scraped label to the candidate, or when an exact
brand remainder identifies the beer. Keep genuinely ambiguous and typo-only
cases unresolved.

The change must not turn brewery matching into a general fuzzy comparison and
must not treat a collaboration credit as a global equivalence between two
breweries.

## Root cause

The Algolia response contains two useful identity fields that the application
currently discards:

- `brewery_alias`, with alternative names for the candidate brewery;
- `alias_alt`, with alternative labels for the candidate beer.

`parseAlgoliaResponse` reduces each hit to the basic `SearchResult` fields, so
the lookup gate sees only the canonical brewery and beer names. It consequently
rejects candidates such as:

- `Magic Road Brewery / Dżemer`, whose candidate has the full alternative label
  `Magic Road Dżemer` as well as `Sadyba Dżemer`;
- `Carlsberg Brewery / okocim jasne`, whose candidate brewery names
  `Carlsberg Polska` as an alias;
- `Stu Mostów Brewery / WRCLW Schöps`, whose candidate brewery aliases include
  `Browar Stu Mostów` and `Stu Mostów`.

The existing brand path has a second, narrower gap. It derives multi-token
comparison keys and therefore cannot recognize exact one-word remainders such
as `Leffe / Ruby`; it also retains an extra brand token in a candidate such as
`CRAFT STAR Double Stout`.

## Data contract

Extend `SearchResult` with optional `brewery_alias` and `alias_alt` string
arrays. `parseAlgoliaResponse` preserves both fields from Algolia, accepting
only string values.

The fields remain optional so the legacy HTML search source, tests, and callers
that do not provide native alias metadata retain their current behavior.

## Matching behavior

### Full beer identity aliases

An `alias_alt` value may admit a candidate only when it matches the complete
normalized input identity: the input brewery or brand label followed by the
complete input beer name. A bare beer-name alias is not enough to bypass the
brewery gate.

This rule accepts `Magic Road Dżemer` as evidence for the Dżemer candidate. It
does not add `Magic Road` as an alias for `Sadyba`, so unrelated beers from
either brewery cannot cross-match.

If more than one candidate is supported by the same identity evidence, the
existing ABV comparison may select it only when exactly one supported candidate
is within tolerance. Otherwise lookup declines the match.

### Candidate brewery aliases

Candidate-native `brewery_alias` values participate in a separate admitted
pool; they are not copied into the curated global brewery alias table. A result
admitted only through this pool must remain uniquely determined after beer-name
and, when supplied, ABV corroboration.

This allows the unique Okocim and WRCLW candidates through. It deliberately
keeps `Lobkowicz Brewery / PLATAN` unresolved: multiple Platan products remain
plausible and more than one agrees with the supplied ABV.

The existing canonical and curated-alias matching paths keep their current
selection semantics.

### Exact brand remainder

For the existing brand-like brewery path, compare the complete input beer name
with a candidate beer-name segment after removing an exact leading input brand
label. The remainder comparison is exact after the project's normal
normalization; it is never fuzzy.

This admits cases such as:

- `Leffe / Ruby` against `Leffe Ruby`;
- `Leffe / Blonde` against `Leffe Blonde`;
- `CRAFT / STAR Double Stout` against `CRAFT STAR Double Stout`.

As with native aliases, multiple exact candidates require a unique ABV-supported
choice. Without a unique result, lookup declines the match.

### Curated factual alias

Add the narrow, verified brewery spelling relationship needed for
`Stern Scheubel Brewery / Vollbier Hell` to the existing curated brewery alias
table. This is a naming variation for one brewery, unlike the Dżemer
collaboration, and therefore belongs in that table.

## Safety properties

- No global `Magic Road` ↔ `Sadyba` brewery alias is introduced.
- Native aliases never make an arbitrary rank-1 candidate win when several
  candidates remain plausible.
- A beer-name alias without the complete input identity cannot bypass a brewery
  mismatch.
- Exact brand remainder matching does not use edit distance or token overlap.
- Results without the new optional metadata behave as before.
- The legacy HTML search fallback remains supported.

## Examples intentionally left unresolved

Issue examples are treated as diagnostic leads, not expected outputs. The
following cases must not be forced through this change:

- `Lobkowicz Brewery / PLATAN`: true ownership relationship, but multiple
  products fit the label and ABV; this belongs to #334's ambiguity work.
- `Primator Brewery / Weizenbier` and `Nachod Brewery / PRIMÁTOR WEIZENBIER`:
  multiple candidates expose the same alternative name and ABV.
- `Kessman Brewery / Hell`: brewery typo handling belongs to #407.
- `Kamenica Brewery / Desitka`: typo and product ambiguity remain.
- `Gui Brewery / Guinnes`: the current query does not retrieve a Guinness
  candidate, so this is a retrieval problem rather than an identity-gate fix.
- `Italio Brewery / Menabrea`: the generic brand label and several same-ABV
  results do not establish one beer identity.
- `Nepomucen⁸ Brewery / Forest`: the reported ABV does not agree with the
  candidate, and the superscript label is not sufficient evidence by itself.

## Tests

Write focused regression tests before implementation for:

- parsing and preserving both Algolia metadata arrays while ignoring non-string
  entries;
- accepting Dżemer through its complete `alias_alt` collaboration label;
- rejecting a same-name candidate when only a bare beer alias supports it;
- accepting Okocim and WRCLW through candidate-native brewery aliases;
- keeping PLATAN unresolved when alias-supported candidates remain ambiguous;
- accepting exact Leffe and CRAFT brand remainders;
- rejecting fuzzy or ambiguous brand remainders;
- accepting the curated Stern Scheubel spelling;
- retaining behavior when metadata is absent.

Run the focused Algolia, alias, and lookup tests, then the full project test
suite and typecheck.

## Specification update

Update the Untappd matching section of `spec.md` to state that native candidate
identity metadata may admit a candidate only with complete identity evidence
and ambiguity protection. Document the exact brand-remainder rule and the
collaboration-specific constraint.

## Out of scope

- General brewery edit-distance matching or typo correction.
- Query expansion and retrieval changes.
- Choosing among genuinely ambiguous beer variants.
- Broadening the curated brewery alias list beyond Stern Scheubel.
- Correcting upstream ABV or catalog data.
- Browser extension behavior or presentation.
