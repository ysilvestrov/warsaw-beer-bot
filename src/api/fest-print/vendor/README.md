# Vendored: NiimBlueLib

`niimbluelib-0.47.0.min.js` is `dist/umd/niimbluelib.min.js` from the npm tarball of
`@mmote/niimbluelib@0.47.0` (MIT, see `niimbluelib-LICENSE`), unchanged.

- sha256: `2e133cd448ed9328b9ee32adf74cd64fba6bba2112821c896af4758a7efcbc6c`
- Why vendored: the print station runs on a phone on festival mobile data, and the build
  container cannot reach the CDN to pin it by hash (spec 2026-09-29-wfp-team-assistant-design.md §8).
- To update: `npm pack @mmote/niimbluelib@<v>`, copy `package/dist/umd/niimbluelib.min.js` here
  under the new version name, update the sha256 above and the path in `src/api/routes/fest-print.ts`.
