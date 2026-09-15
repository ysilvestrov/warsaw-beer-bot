# #650 Flasker: preserve a title whose brewery is supplied only by product detail

## Purpose

On Flasker, a product title can start with the beer name rather than the brewery.
The grid parser must retain that entire title when the product-detail JSON-LD
`brand` later supplies the brewery. This fixes name matching and check-in badges
for cards without a published Untappd beer ID; direct IDs remain their own,
already-existing identity path.

## Scope

- Keep the initial parser's distinction between a recognized brewery and its
  one-word fallback private to the Flasker adapter.
- If detail hydration resolves a non-placeholder brand for a card parsed by the
  fallback, move the fallback word back in front of the beer name before writing
  the canonicalized brand as its brewery.
- Do not alter established cards whose brewery came from a product tag, product
  slug, registry title prefix, or explicit `Brewery: beer` title.
- Add regression coverage for title-first examples from #650 and update the
  extension's user-facing changelog and install guide.

## Non-goals

- Do not change the generated brewery registry, matching service, card API, or
  direct-`bid` handling from #633.
- Do not infer whether an unknown title prefix is a brewery outside the existing
  parser rules.
- Do not bulk repair cached or historical matches; normal re-parsing refreshes
  cards going forward.

## Design

`parseTitle` continues to expose its current public result. Internally, the
Flasker adapter also records, per card element, whether that result came from
`splitBreweryName` rather than a trusted brewery source. That provenance is
adapter-local transient state, like the existing detail URL and proof markers.

When `loadCardDetails` receives a usable JSON-LD brand for such a fallback card,
it reconstructs the pre-split title from the card's fallback brewery and current
name, then replaces `card.brewery` with `canonicalizeBrand(detail.brand)`. The
marker is consumed during reconstruction, so repeated hydration is idempotent.
Explicit colon-separated titles and one-word titles never receive the marker.
Cards whose initial brewery was trusted keep their current name unchanged. The
imported beer placeholder keeps its existing no-overwrite behavior.

## Recorded claims and evidence

| Recorded state / claim | Evidence |
| --- | --- |
| A fallback parse has discarded the first title word from `card.name`. | The live-equivalent parser probe returned `VibrantPour | Love on Tap` only when supplied a trusted `Vibrant Pour` tag; without it `splitBreweryName` takes the first token at `extension/src/sites/flasker.ts:335-337`. #650 records the resulting production card as `VibrantPour | on Tap`. |
| JSON-LD `brand` is authoritative for the card brewery but not necessarily a title prefix. | #650's 2026-09-15 catalog probe found 57 of 709 non-placeholder-brand cards where the lost head belongs to the Untappd beer name. Detail hydration currently assigns the canonical brand at `flasker.ts:549-553`. |
| A trusted parse already has the full beer name and must not be reconstructed. | Existing regression `parseTitle('Barely Beer …', { productTags: ['mad brew'] })` asserts `Mad Brew | Barely Beer` in `flasker.test.ts:55-58`; prefixing again would corrupt it. |
| A detail `bid` is a separate identity mechanism. | Existing `ProductDetail` carries `bid`/`bidSlug` and hydration assigns them independently at `flasker.ts:555-558`; #650 explicitly excludes the #633 published-bid rescue path. |

## Tests and verification

- First add a hydration regression that starts with a title-first card such as
  `Love on Tap 6% 330ml` and returns JSON-LD `Vibrant Pour`; it must fail on the
  current branch as `VibrantPour | on Tap`, then pass as `VibrantPour | Love on Tap`.
- Cover a trusted-name control: detail hydration must not duplicate a name when
  the grid title has already been resolved from trusted evidence.
- Verify that explicit colon-separated titles, one-word titles, and a repeated
  successful hydration all keep the beer name exactly once.
- Run the focused Flasker test file, the full extension test suite, and extension
  typecheck.
