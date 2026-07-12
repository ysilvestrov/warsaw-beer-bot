# Flasker metadata-led brewery identity and merchandising-prefix cleanup

- **Date:** 2026-06-19
- **Scope:** Browser-extension Flasker adapter only
- **Status:** Approved design

## Problem

The Flasker adapter currently assumes the first word of every product title is the
brewery. Production orphan evidence disproves that assumption:

- some titles omit the brewery (`Duchesse de Bourgogne`);
- some begin with a product family (`SmoothieMaker Banana Coconut`);
- some use a short display brewery that differs from Untappd
  (`Vibrant Pour` versus `VibrantPour`);
- some begin with a merchandising label (`ПРЕДРЕЛІЗ DE ZWARTE REGEL: ...`).

Flasker already exposes stronger identity evidence in product tags and product URLs,
but `extension/src/sites/flasker.ts` currently discards it. The resulting bad
brewery/name pair passes through `/match`, becomes an orphan, and may later fail
Untappd enrichment even when the correct candidate is present.

## Goals

1. Prefer explicit Flasker brewery metadata over the title-first-word heuristic.
2. Apply the same identity resolution across archive, table, and block views.
3. Remove a small, explicit set of leading Flasker merchandising labels from beer
   names.
4. Preserve the current parser as a conservative fallback when metadata is absent,
   unknown, or conflicting.

## Non-goals

- No server, matcher, API, database, or generic `SiteAdapter` changes.
- No generic inference of breweries from arbitrary product tags.
- No fuzzy interpretation of merchandising labels.
- No product-name corrections such as `Sommer` → `Summer`, `Tripel` → `Triple`,
  or localized Syrskald flavor mappings. Those require a separate design.
- No special handling for `DE ZWARTE REGEL` products. Captured rows carry a
  `Vibrant Pour` tag while Untappd catalogs the candidate under `Mad Brew`; this
  contradictory source evidence remains unresolved rather than adding a
  product-family URL override.
- No network requests from the content script.

## Architecture

### Raw evidence

Extend Flasker's private `RawEntry` type:

```ts
interface RawEntry {
  el: HTMLElement;
  title: string;
  categoryHint?: string;
  productTags: string[];
  productUrl?: string;
}
```

Each view remains responsible only for extracting evidence:

| View | Product tags | Product URL |
|------|--------------|-------------|
| Archive (`li.product`) | visible `.mb-thumb-tag` text; class slugs may be used as a fallback | `.woocommerce-LoopProduct-link[href]` |
| Table (`tr[data-title]`) | names parsed from `data-product_tag` entries of the form `id:name` | `data-href` |
| Block (`li.wc-block-grid__product`) | none | product-title anchor `href` |

Tag parsing trims whitespace, ignores empty values, and treats tag names
case-insensitively. URL parsing uses only the final `/product/<slug>/` segment from a
valid Flasker URL. Malformed attributes produce no evidence and do not reject a card.

### Explicit brewery rules

Keep a Flasker-local rule table:

```ts
interface BreweryRule {
  canonical: string;
  tags: string[];
  slugPrefixes: string[];
  titleAliases: string[];
}
```

- `canonical` is the brewery string sent to `/match`.
- `tags` are exact trusted Flasker tag names after case/whitespace normalization.
- `slugPrefixes` are exact trusted prefixes of the product slug.
- `titleAliases` are display brewery strings that may be removed from the start of
  the title head.

The initial rule set is deliberately small and evidence-backed:

| Canonical brewery | Trusted evidence | Display aliases |
|-------------------|------------------|-----------------|
| `VibrantPour` | tag `Vibrant Pour`; slug prefixes `vibrant-pour-`, `vibrantpour-` | `Vibrant Pour`, `VibrantPour` |
| `Mad Brew` | tag `mad brew`; slug prefixes `mad-brew-`, `mad-` | `Mad Brew` |
| `Geuzestekerij De Cam` | tag `De Cam`; slug prefix `de-cam-` | `De Cam` |
| `Hoppy Hog Family Brewery` | tag `Hoppy Hog`; slug prefix `hoppy-hog-` | `Hoppy Hog` |
| `Brouwerij Verhaeghe` | tag `Brouwerij Verhaeghe`; slug prefix `duchesse-de-bourgogne-` | `Brouwerij Verhaeghe` |
| `Flasker` | tag `Flasker`; slug prefix `flasker-` | `Flasker` |
| `Malle` | tag `Malle`; slug prefix `malle-` | `Malle` |
| `Гонір - Honir Brewery` | tags `Гонір`, `Honir`; no slug prefix until one is fixture-pinned | `Гонір`, `Honir` |

Before implementation, every initial tag and slug value must be pinned by a captured
fixture. A rule without fixture evidence is omitted rather than guessed. Future rules
follow the same requirement.

## Resolution algorithm

For each `RawEntry`:

1. Preserve the existing volume gate, ABV parsing, and title-head extraction.
2. Match normalized product tags against the explicit brewery rules.
3. If exactly one rule matches tags, select it. Tag evidence has highest priority.
4. Otherwise, if no tag rule matched, match the product slug against explicit rule
   prefixes. If exactly one rule matches, select it.
5. Conflicting tag matches or conflicting slug matches select no rule. Do not resolve
   a tag conflict using weaker URL evidence.
6. With a selected rule:
   - emit its `canonical` brewery;
   - start the beer-name candidate as the complete title head;
   - remove the longest `titleAlias` that occurs at the beginning on a token boundary;
   - retain the complete title head when no display alias matches.
7. Without a selected rule, use the existing `splitBreweryName(head)` result unchanged.
8. Apply merchandising-prefix cleanup to the derived beer name.
9. If cleanup produces an empty name, discard the cleanup result and retain the
   pre-cleanup name.

This preserves titles where the brewery is omitted. For example, the
`Brouwerij Verhaeghe` rule keeps `Duchesse de Bourgogne` intact because no display
brewery alias appears at its start.

## Merchandising-prefix cleanup

Strip at most one leading label from this case-insensitive allowlist:

- `ПРЕДРЕЛІЗ`
- `ПРЕДРЕДІЗ`
- `ПРОБНИК:`

The match must start at the beginning of the derived beer name and end on a token
boundary. Cleanup also removes immediately adjacent whitespace and separator
characters (`:`, `-`, `–`, `—`). The same words in the middle of a name remain
untouched. Unknown labels remain untouched.

Example:

```text
tag: mad brew
title: ПРЕДРЕЛІЗ Galaxy Juice 6% 330ml

brewery rule → Mad Brew
name before cleanup → ПРЕДРЕЛІЗ Galaxy Juice
final name → Galaxy Juice
```

Cleanup runs after metadata resolution and after the current fallback parser so its
behavior is shared by all three views.

## Failure behavior

- Missing or malformed metadata: use the current title parser.
- Unknown tags or slug prefixes: use the current title parser.
- Multiple brewery rules at the same evidence level: use the current title parser.
- An empty name after alias or merchandising cleanup: retain the last non-empty name.
- Non-beer filtering, ABV parsing, and volume parsing retain their current behavior.

The resolver is pure and produces no logs. Its observable fallback is the existing
card identity, avoiding new failure modes in the content script.

## Testing

Add focused tests to `extension/src/sites/flasker.test.ts`:

### Evidence extraction

- Archive extracts visible product tags and the product URL.
- Table parses tag names from `data-product_tag` and reads `data-href`.
- Block reads the product URL and works without product tags.

### Precedence and fallback

- A trusted tag overrides an incorrect first title token.
- A trusted slug resolves a block card without tags.
- A trusted tag wins over a conflicting URL rule.
- Two conflicting trusted tags fall back to the current title parser.
- Unknown tags and slugs fall back to the current title parser.

### Name derivation

- The longest matching display alias is removed.
- A title with no display brewery retains its complete head.
- `Vibrant Pour` emits canonical brewery `VibrantPour`.
- `Duchesse de Bourgogne` emits brewery `Brouwerij Verhaeghe` and retains its name.
- `SmoothieMaker Banana Coconut` emits brewery `Mad Brew` without losing
  `SmoothieMaker` from the name.
- `De Cam Abrikoos Rabarber (2018)` removes the `De Cam` display alias.
- `Hoppy Hog Winter Cherry` emits `Hoppy Hog Family Brewery` / `Winter Cherry`.

### Merchandising labels

- Each allowed label is stripped at the start of a name.
- Matching is case-insensitive.
- Adjacent separators and whitespace are removed.
- A label in the middle of a name remains.
- An unknown leading label remains.
- Empty-name cleanup retains the original non-empty name.
- A synthetic metadata-backed title verifies prefix removal independently of the
  excluded `DE ZWARTE REGEL` products.

Existing archive, table, block, ABV, volume, non-beer, and conformance tests must
remain green. Fixture-level tests must assert exact brewery/name pairs rather than
only non-empty fields.

## Files in scope

- `extension/src/sites/flasker.ts`
- `extension/src/sites/flasker.test.ts`
- `extension/tests/fixtures/flasker*.html` only where evidence is missing
- `extension/CHANGELOG.md`
- `spec.md`

## Rollout and verification

1. Run the Flasker adapter tests and the complete extension suite.
2. Load archive, product-table, and block views in a browser and verify the exact
   brewery/name payloads for the fixture-backed cases.
3. Release the extension using the existing extension release workflow.
4. After clients update, review newly-created Flasker `enrich_failures`; old orphan
   rows are not evidence of regression.
