// Process-level monotonic counter, bumped by the storage mutators that change a
// matchable beer field (see beers.ts). The /match catalog cache reads it to decide
// when to rebuild. Single-threaded JS + one better-sqlite3 connection ⇒ a plain
// number is race-free. Deliberately NOT PRAGMA data_version: that only reflects
// commits from OTHER connections, so it never moves on our own single-connection writes.
let version = 0;

export function catalogVersion(): number {
  return version;
}

export function bumpCatalogVersion(): void {
  version++;
}
