# Beershop Browser Extension Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fixture-backed Beershop adapter for five localized domains while excluding the storefront's non-beer categories.

**Architecture:** Add one `SiteAdapter` that parses the shared UPgates SSR card markup. Combine localized URL gates, stable UPgates category IDs, and the existing shared product-name filter; register the adapter through the existing registry and manifest surfaces.

**Tech Stack:** TypeScript, Vitest, jsdom, Vite, Chrome Manifest V3

**Spec:** `docs/superpowers/specs/2026-08/2026-08-28-beershop-adapter-design.md`

## Global Constraints

- Support `beershop.pl`, `beershop.cz`, `beershop.sk`, `beershop.eu`, and `beershop.de`, including apex hosts and subdomains.
- Preserve cider, alcohol-free beer/radlers, and kvass.
- Do not interpret Plato degree tokens as ABV.
- Use the existing adapter architecture and dependencies.
- Update `spec.md`, both extension installation guides, and `extension/CHANGELOG.md`.

---

### Task 1: Capture live storefront evidence and write failing adapter tests

**Files:**
- Create: `extension/tests/fixtures/beershop.html`
- Create: `extension/tests/fixtures/beershop.nonbeer.html`
- Create: `extension/src/sites/beershop.test.ts`
- Modify: `extension/src/sites/registry.test.ts`
- Modify: `extension/src/manifest.test.ts`

**Interfaces:**
- Consumes: `SiteAdapter`, `pickAdapter(url: URL)`, and the existing fixture/conformance conventions.
- Produces: failing expectations for adapter id `beershop`, card parsing, localized route gates, category-ID gates, registry selection, and manifest coverage.

- [x] **Step 1: Capture the live Polish beer catalog and lemonade/cola pages as HTML fixtures.**

- [x] **Step 2: Write tests that expect the first beer fixture card to parse as brewery `Klín` and name `12° Berry Sour Ale`.**

- [x] **Step 3: Add table-driven host, localized route, stable category-ID, shared gift-pack, and eligible-route cases.**

- [x] **Step 4: Run the focused tests and confirm they fail because the adapter, registry entry, and manifest patterns do not exist.**

Run: `cd extension && npm test -- --run src/sites/beershop.test.ts src/sites/registry.test.ts src/manifest.test.ts`

Expected before implementation: FAIL on missing Beershop adapter/registration/manifest coverage.

### Task 2: Implement and integrate the adapter

**Files:**
- Create: `extension/src/sites/beershop.ts`
- Modify: `extension/src/sites/registry.ts`
- Modify: `extension/manifest.config.ts`

**Interfaces:**
- Consumes: `SiteAdapter`, `Card`, and `isNonBeerName(name: string): boolean`.
- Produces: `export const beershop: SiteAdapter`, registered in `ADAPTERS`, with five-domain manifest injection.

- [x] **Step 1: Implement bounded base-host matching for all five language domains.**

- [x] **Step 2: Parse `article.card-item[data-product-id]`, `.p-i-header strong`, and remaining header text without deriving ABV.**

- [x] **Step 3: Add localized non-beer route sets plus stable UPgates category IDs. Read category metadata from `root.ownerDocument` when parsing a scoped re-render grid.**

- [x] **Step 4: Register `beershop` and add apex/subdomain manifest patterns for every language host.**

- [x] **Step 5: Run focused adapter, registry, manifest, and conformance tests.**

Run: `cd extension && npm test -- --run src/sites/beershop.test.ts src/sites/registry.test.ts src/manifest.test.ts src/sites/conformance.test.ts`

Expected: PASS.

### Task 3: Document and verify the user-facing change

**Files:**
- Modify: `spec.md`
- Modify: `docs/extension-install-uk.md`
- Modify: `docs/extension-install-en.md`
- Modify: `extension/CHANGELOG.md`

**Interfaces:**
- Consumes: the final adapter behavior and supported host list.
- Produces: user and maintainer documentation consistent with the implementation.

- [x] **Step 1: Add the Beershop parser, host, and non-beer-gate contract to `spec.md`.**

- [x] **Step 2: List all five supported domains in both installation guides and add an Unreleased changelog entry.**

- [x] **Step 3: Run the full extension suite, typecheck, and production build.**

Run: `cd extension && npm test`

Run: `cd extension && npm run typecheck`

Run: `cd extension && npm run build`

Expected: all tests pass, typecheck exits zero, and Vite produces the extension package.

- [x] **Step 4: Load the built extension in Chromium and verify the live beer catalog renders badges while the live lemonade/cola page renders none.**

Expected: beer catalog contains parsed cards and badges; the non-beer page contains product cards but zero extension badges.
