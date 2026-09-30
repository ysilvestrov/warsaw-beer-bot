# #751: Comma-split Untappd identity aliases

## Problem

The shop lists `Kojetin Brewery / Som pohár čau 14°` (6.0%). Untappd's beer
6690910 is `SomPivo — Som Pohár, Čau` (6.0%), with a collaboration credit to
Měšťanský pivovar Kojetín. Its raw Algolia record has `brewery_alias: []` and
`alias_alt: ["Měšťanský pivovar Kojetín Som Pohár", " Čau"]`. The complete
collaborator-and-beer label has been split at the comma. The existing complete
identity rule therefore misses it. The #679 workaround pairs `kojetin` with
`sompivo` globally, admitting unrelated beers from either brewery.

This is an upstream record shape, not a split by our parser: raw records for
6829330 (`Krush the Dam, Dolcita!`) and 6815466 (`Саур: Суниця, Полуниця,
Мʼята`) likewise carry consecutive `alias_alt` elements ending and beginning
at the title's commas. The cause inside Untappd's indexing pipeline is unknown.

## Rule

Keep the existing complete `alias_alt` identity rule. Add a separate fallback
inside `lookupBeer` for a candidate whose **registered beer name contains a
comma** and whose `alias_alt` contains multiple parts. Join all parts with a
comma, restoring the combined alternative label. Admit the candidate only if:

1. The normalized shop beer name equals the normalized registered beer name and
   contains at least two tokens. This permits shop-only grade noise (`14°`) but
   rejects partial titles.
2. The base-normalized restored label ends with the complete base-normalized
   registered beer title. Its remaining prefix, normalized as a brewery, equals
   the normalized shop brewery. Never treat that prefix as a global alias.
3. Exactly one distinct `bid` has this evidence. ABV never resolves competing
   bids; known contradictory ABV vetoes the sole candidate.

The fallback runs after ordinary brewery and complete-identity matches, before
candidate-native brewery aliases. It does not change query construction, the
ordinary identity rule, or catalog normalization. Remove the
`['kojetin', 'sompivo']` curated pair and its pair-specific test. This also
closes the brewery-wide equivalence in `/match`, which reads the same pair list;
the new fallback is intentionally limited to enrich `lookupBeer`.
An ambiguous or ABV-vetoed split identity falls through to later evidence
stages and other brewery search parts; it does not veto an independent match.

## Evidence and claims

| Recorded claim | Evidence |
| --- | --- |
| Algolia identifies bid 6690910 as a Kojetín collaboration | Live raw object: `alias_alt` contains `Měšťanský pivovar Kojetín Som Pohár`, ` Čau`; brewery is `SomPivo`; ABV 6.0. |
| The split is not caused by our code | Raw Algolia object already contains two array members; `parseAlgoliaResponse` only trims them. |
| The rule can identify this beer without equating two breweries | A regression test must fail with the global pair removed and pass with the fallback. |
| Unrelated SomPivo beers remain gated | A negative test with the same name and ABV but no qualifying `alias_alt` must return `not_found`. |
| The fallback does not combine arbitrary alternative names | Tests cover a comma-free registered title, a mismatched title, and contradictory ABV. |

## Verification

Run the focused `lookupBeer` and brewery-alias suites, the full `npm test &&
npm run typecheck` gate, and a read-only live replay of beer 38381 against
Algolia using the new branch. No production database writes are part of this
change.
