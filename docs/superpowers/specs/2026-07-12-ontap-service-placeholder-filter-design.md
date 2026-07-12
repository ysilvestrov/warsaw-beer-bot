# Ontap Service Placeholder Filter Design

**Date:** 2026-07-12  
**Issue:** #285, split from #255

## Problem

Ontap can publish a tap slot as an operational placeholder rather than a beer. The
production example `KRAN W SERWISIE`, paired with `Kran czeka na lepsze czasy
Brewery`, passed through parsing and became an orphan catalog identity.

The existing ontap non-beer gate rejects several explicit non-beer metadata shapes,
but does not recognize tap-out-of-service wording.

## Scope

Add a conservative ontap-only rejection for explicit tap-out-of-service phrases.
The gate will inspect the raw beer name as well as the existing style and brewery
fields, because the strongest source signal is `KRAN W SERWISIE` itself.

The first supported sentinel is the normalized exact phrase `kran w serwisie`.
Matching is case-insensitive and whitespace-insensitive through the gate's existing
normalization. Substring matching is deliberately excluded so a future legitimate
beer title containing similar words is not rejected accidentally.

## Data Flow

`parsePubPage` continues to return the source row unchanged. During
`refreshOntap`, `isOntapNonBeerTap` rejects the placeholder before snapshots,
catalog rows, match links, or enrich failures are written.

No matcher, catalog, schema, or cleanup behavior changes. Historical rows are
handled separately by #286.

## Testing

Add a focused unit case to the existing ontap non-beer table tests proving that
`KRAN W SERWISIE` is rejected. Retain a nearby negative case demonstrating that
ordinary beer names remain eligible. Run the targeted test first, then the full
test suite.

## Non-Goals

- General fuzzy classification of placeholder text.
- Filtering arbitrary brewery or beer names containing `kran` or `serwis`.
- Removing historical `beers` or `enrich_failures` rows.
- Addressing already-fixed Funkyshop and ontap identity defects from #255.
