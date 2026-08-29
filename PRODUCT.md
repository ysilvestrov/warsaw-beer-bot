# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Craft-beer enthusiasts who use Untappd and want their drinking history to help them make better choices while shopping online or visiting pubs. They need to distinguish genuinely new beers from beers they have already tried, without manually cross-checking shop listings, current tap lists, and their Untappd history.

## Product Purpose

Warsaw Beer Overlay is a personal beer-discovery ecosystem consisting of a Telegram bot, a matching API, and a browser extension. It helps users see which beers they have already tried while browsing supported craft-beer shops, discover interesting untried beers currently on tap, and build walking routes through pubs that serve them.

Success means that a user can act on their own history with less manual comparison while the product remains honest about incomplete data and uncertain matches.

## Positioning

The product joins live or in-context beer availability with a user's personal Untappd history. Its distinguishing mechanism is a shared matching layer that can enrich shop catalogues and current pub taps with personal tried status, ratings, and explicit uncertainty instead of treating every inferred identity as exact.

## Operating Context

- In supported online craft-beer shops, the browser extension decorates product cards with community ratings and personal tried status.
- In Telegram, users link an Untappd profile, optionally import or synchronize check-ins, filter current tap lists, discover untried beers, and request walking routes between pubs.
- The API connects these surfaces to the beer catalogue and each authenticated user's history.
- Public setup guides, a privacy policy, and Chrome Web Store materials support installation and informed use.

## Capabilities and Constraints

- The system combines shop product data, current tap data, Untappd catalogue data, and a user's check-in history.
- Personal tried status depends on a linked or synchronized history; anonymous extension use can still show non-personal beer information.
- Matching is not always certain. Exact, probable, known-but-unresolved, and unmatched states must remain distinguishable.
- Pub discovery and routing are available only for curated supported cities; users outside that scope can still use non-city-specific capabilities.
- The bot supports Ukrainian, Polish, and English.
- The product is implemented as a Telegram bot, a read-oriented HTTP API, a Chrome extension, and public web documentation. Existing technical and behavioral constraints in `spec.md` remain authoritative.

## Brand Commitments

- Product name: **Warsaw Beer Overlay**.
- Personal, non-commercial project by Yuriy Silvestrov.
- Beer-domain language should remain direct and useful rather than making promotional claims unsupported by evidence.
- The bot's Ukrainian, Polish, and English experience is a durable product commitment.

## Evidence on Hand

- `spec.md` is the canonical behavior specification for the live implementation.
- `README.md`, `docs/USER-GUIDE.md`, and the English and Ukrainian extension setup guides document current user workflows.
- `docs/cws-listing.md` and `docs/cws-data-usage.md` document the Chrome Web Store proposition and disclosed data flows.
- `extension/icons/icon.svg` and the shipped extension icons are existing brand assets.
- Automated tests cover the bot, API, matching logic, and extension behavior.
- No testimonials, customer logos, adoption figures, or performance claims are currently documented; future product work must not invent them.

## Product Principles

1. **Make personal history useful in the moment.** Bring tried status and ratings into the shop or pub decision instead of requiring manual comparison.
2. **Support discovery across both shopping and going out.** Treat the browser extension and pub-finding bot as parts of one product, backed by the same beer identity and history.
3. **Be honest about uncertainty.** Preserve distinct uncertain and unresolved states; never present a probable match as a confirmed fact.
4. **Minimize and explain personal-data use.** Collect and transmit only what the documented workflows require, and keep user-facing disclosures aligned with actual behavior.
5. **Remain personal and non-commercial.** Avoid invented social proof, commercial positioning, or claims that do not belong to the project's established purpose.
