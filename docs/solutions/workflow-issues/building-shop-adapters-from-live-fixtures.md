---
title: Building Shop Adapters From Live Fixtures
date: 2026-06-11
category: workflow-issues
module: Browser extension shop adapters
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - "Adding a supported shop to the browser extension"
  - "Building a parser from captured storefront HTML"
  - "Reviewing adapter PRs that touch registry, manifest, fixtures, and spec"
tags: [shop-adapter, parser, browser-extension, fixtures, review-workflow, worktrees]
---

# Building Shop Adapters From Live Fixtures

## Context

The WineTime adapter work solved issue #88 by adding support for `winetime.com.ua` to the browser extension. The implementation itself was straightforward after the storefront shape was understood, but the session exposed several workflow and parser-design traps that can recur when adding future shop adapters.

The final WineTime adapter parses SSR product cards, prefers embedded product metadata keyed by product id, falls back to visible DOM text, registers the shop in the adapter registry and manifest, and adds fixture-backed tests plus changelog/spec updates.

## Guidance

Start adapter work in an isolated worktree from the correct base branch before making code changes. During the WineTime work, the first implementation branch was accidentally based on an unrelated Bierloods22 branch, which made the diff contain unrelated adapter changes. The fix was to rebase the WineTime branch onto `main`, resolve conflicts, and explicitly keep only the intended WineTime work. This is now reinforced in `AGENTS.md`: always set up an isolated worktree when developing a change.

Use the live storefront fixture to identify the most stable data source, not just the visible DOM. WineTime rendered visible cards as `a.product-micro`, but the most reliable brewery/title data lived in `window.initialData.category.products` and was connected to cards through `data-productkey`. The adapter therefore used metadata as the primary source:

```ts
const id = Number(el.querySelector<HTMLElement>('[data-productkey]')?.dataset.productkey);
const product = Number.isFinite(id) ? meta.get(id) : undefined;
const rawTitle = product?.title ?? text(el.querySelector('.product-micro--title'));
const brewery = product?.manufacturer?.title?.trim() || visibleBrewery(el);
```

Keep DOM fallback behavior even when metadata is available. A storefront can remove or rename embedded globals without changing visible HTML. WineTime tests disabled the `window.initialData.category` assignment and asserted that visible title/brewery parsing still returned usable cards.

Make metadata-preference tests prove the preference. The first metadata test was weak because the visible DOM and embedded metadata produced the same `Meteor / Pils` result; the test would have passed even if metadata parsing broke. The fix was to mutate a local parsed fixture document so the visible brewery was wrong, then assert that the parsed result still used embedded metadata:

```ts
function withVisibleBrewery(source: string, productKey: string, brewery: string): string {
  const doc = new DOMParser().parseFromString(source, 'text/html');
  const card = doc.querySelector(`[data-productkey="${productKey}"]`)?.closest('a.product-micro');
  if (!card) throw new Error(`Missing WineTime fixture card for product key ${productKey}`);

  const rows = Array.from(card.querySelectorAll('.j-grow-1-xs.j-size-0\\.75-xs'));
  const row = rows[rows.length - 1];
  if (!row) throw new Error(`Missing visible brewery row for product key ${productKey}`);

  row.textContent = brewery;
  return doc.documentElement.outerHTML;
}
```

Treat product-title cleanup as conservative normalization, not a full taxonomy parser. WineTime titles included category prefixes, brewery names, Ukrainian descriptors, packaging words, and volume suffixes. The final implementation stripped only the known category prefix, exact brewery prefixes, trailing volume, and trailing Ukrainian descriptors such as `світле`, `темне`, `нефільтроване`, and `фільтроване`. It deliberately preserved label words such as `CAN` because those may be part of the product name.

When the PR is open, wait for automatic review and evaluate findings technically. The WineTime automatic review produced one useful test-helper finding and two suggestions that did not justify more code: a local DOM mutation was already isolated to a per-test document, and a custom error class or full HTML dump would add noise to a fixture helper. The useful finding was fixed; the others were answered in review threads with the technical rationale and then resolved.

After merge, clean up only the completed adapter work. In this session, `main` also contained unrelated merged work, and local branches/worktrees for other issues existed. Cleanup removed the WineTime worktree, local branch, and remote branch, switched the root checkout to `main`, and pulled the merge commit, while leaving unrelated issue branches untouched.

## Why This Matters

Shop adapters are narrow changes, but they touch many integration surfaces: captured fixtures, parser logic, conformance tests, registry, manifest matches, changelog, and spec documentation. Small base-branch mistakes or weak tests can make a PR look correct while either dragging unrelated work into the diff or failing to prove the parser uses the intended data source.

The metadata-first plus fallback pattern makes adapters resilient to storefront markup changes without overfitting to every visible text row. The review discipline keeps automatic comments useful without turning every suggestion into unnecessary complexity.

## When to Apply

- Add a new browser-extension supported shop.
- Update an existing shop adapter after storefront markup changes.
- Review adapter PRs that add fixtures and parser cleanup rules.
- Rebase adapter work after another shop adapter lands on `main`.

## Examples

For SSR storefronts, prefer this workflow:

1. Capture the live page as a fixture.
2. Inspect repeated card nodes and embedded product state.
3. Parse cards from stable selectors.
4. Prefer embedded metadata when it has product identity and manufacturer/title.
5. Keep DOM fallback tests.
6. Add a metadata-preference test where DOM text is intentionally wrong.
7. Run targeted adapter/conformance/manifest tests, then the full extension test suite and build.

Avoid this workflow:

1. Start from an unrelated feature branch.
2. Parse only the visible card text.
3. Add a test whose expected metadata value also matches the fallback DOM value.
4. Accept every automated review suggestion without checking whether it improves this codebase.

## Related

- Issue #88: Add WineTime to the supported shops.
- PR #114: WineTime adapter implementation and follow-up review fixes.
- `docs/adapter-authoring.md`: baseline adapter-authoring guide.
- `spec.md` section 6: browser extension adapter contract.
