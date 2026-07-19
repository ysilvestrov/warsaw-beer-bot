# Changelog page on GitHub Pages — implementation plan

Spec: `docs/superpowers/specs/2026-07/2026-07-19-changelog-page-design.md`

## Task 1 — Generalize `renderPage` (TDD)

`scripts/render-docs.ts` / `scripts/render-docs.test.ts`.

Make `RenderOptions`:
- `title?: string` — optional, defaults to `'Warsaw Beer Overlay — Setup'` (preserves
  existing install-guide output and the current test).
- `altLang?`, `altHref?` — optional. The nav renders the alternate-language link **only
  when both are provided**; otherwise the nav contains just the "← Home" link.

Steps (red → green):
1. Add tests to `render-docs.test.ts`:
   - custom `title` appears in `<title>` when provided;
   - when `altLang`/`altHref` are omitted, output has the "← Home" link but no
     alternate-language link (assert `українською` / `Read in English` absent, and no
     second nav `<a>`); the existing "with alt link" cases stay green.
2. Update `renderPage`: parametrize `<title>`; build the nav link list conditionally.
3. Run `npx vitest run scripts/render-docs.test.ts` → green.

## Task 2 — Add the changelog render target

`scripts/render-docs.ts` `main()`.

Add a third target: `extension/CHANGELOG.md` → `site/changelog/index.html`, with
`lang: 'en'`, `title: 'Warsaw Beer Overlay — Changelog'`, `homeHref: '../'`, and no
`altLang`/`altHref`. Install-guide targets pass `title: 'Warsaw Beer Overlay — Setup'`
explicitly (or rely on the default).

Verify: `npm run render-docs` writes `site/changelog/index.html`; open it / grep for a
known changelog line (e.g. `0.12.0`) and confirm no alternate-language nav link.

## Task 3 — Link from the landing page

`site/index.html`: add `<li>📝 <a href="changelog/">Changelog</a></li>` to `ul.links`
(after the two install-guide links).

## Task 4 — CI trigger

`.github/workflows/pages.yml`: add `extension/CHANGELOG.md` to `on.push.paths`.

## Verification

- `npx vitest run scripts/render-docs.test.ts` green.
- `npm run render-docs` regenerates `site/install/`, `site/install-uk/`, and the new
  `site/changelog/` with no diff to the install pages beyond expected.
- `site/changelog/index.html` is self-contained (no external asset refs) and contains
  the rendered changelog with the "← Home" link and no alt-language link.
- Landing page links to `changelog/`.

## Notes

- Docs-only + build-script change; no `spec.md` (product spec) change needed. This is a
  user-facing site page but not an `extension/**` runtime change, so
  `docs/extension-install-uk.md` does not require an update.
