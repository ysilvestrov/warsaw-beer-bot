# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Browser Extension

### Browser Extension Client
The read-only extension surface that overlays a user's beer history and ratings onto supported craft shop catalog pages.

### Supported Shop
A storefront whose catalog pages the Browser Extension Client is expected to recognize, parse, and decorate with beer-history overlays.

### Site Adapter
A shop-specific parser contract that decides whether a page belongs to a Supported Shop and extracts Product Cards into normalized brewery/name pairs for matching.

### Product Card
The repeated catalog item on a Supported Shop page that represents one beer candidate for overlay matching.

### Fixture
A captured storefront page used to make a Site Adapter testable without depending on the live shop during test runs.

## Flagged ambiguities

- "Shop adapter" and "site adapter" refer to the same concept in adapter work; prefer Site Adapter in durable documentation.
