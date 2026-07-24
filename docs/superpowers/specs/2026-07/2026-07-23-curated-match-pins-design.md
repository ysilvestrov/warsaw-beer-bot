# Curated match pins — durable manual links for name-divergent orphans (#343)

**Date:** 2026-07-23
**Issue:** #343 (`[matcher-bug]` two-name `A / B Brewery` contract-brewer field zeroes search), also serves the broader name-divergence class #229.

## Problem

Some on-tap beers can **never** be matched to Untappd from their scraped data. The shop's
beer name diverges from the Untappd title with no derivable relationship, so the Untappd
search returns 0 candidates forever. Example from today's batch:

- Orphan `33280` — shop `Recraft / Z INNEJ BECZKI Brewery` / `Urodzinowe` ("birthday
  [beer]") is, per human knowledge, Untappd **ReCraft — Banany Na Rauszu 2026**
  (bid `6614460`). Query `Recraft Urodzinowe` → 0 candidates. No algorithm can bridge
  `Urodzinowe` → `Banany Na Rauszu 2026`.

These need a **manual link a human curates once**. The system currently has no durable way
to hold such a link:

- `untappd_id` is `UNIQUE` per beer row, so when the target bid already belongs to a
  canonical row (as `6614460` belongs to row `28831`), the only data-model expression of
  "this tap is that Untappd beer" is a **merge**: repoint the tap's `match_link` to the
  canonical row and drop the orphan.
- But the on-tap ingest (`src/jobs/refresh-ontap.ts`) **re-matches every tap on every
  snapshot** and blindly overwrites its `match_link` via `upsertMatch`. `Urodzinowe` will
  never fuzzy-match `Banany Na Rauszu 2026` in the local catalog, so ingest recreates the
  orphan and clobbers the merge on the next snapshot. Unlike a normal enrich-merge it never
  self-heals, because the Untappd search also yields 0 candidates.
- The column meant to protect a human decision, `match_links.reviewed_by_user`, is **dead
  code**: never set to `1` anywhere, never read by ingest. (`markReviewed` /
  `listUnreviewedBelow` in `src/storage/match_links.ts` have no callers.)

## Goals

1. A curated match pin survives every subsequent snapshot ingest (no auto-rematch clobber).
2. A reusable, tested operation to create a pin for both data-model cases (merge into an
   existing canonical row, or set `untappd_id` on the orphan's own row).
3. Pins are trivially revocable and auditable (the residual stale-pin risk is handled by
   people, not code — see Non-goals).
4. Resolve #343: pin `33280 → 28831`. (Sibling `33238` was already linked directly on
   2026-07-23 — its bid `1093012` had no local owner, so a plain `untappd_id` set sufficed
   and is self-durable because the shop's tap string re-matches the same row each snapshot.)

## Non-goals

- **Automatic stale-pin detection.** The pin is keyed on `match_links.ontap_ref`, which is
  just the scraped beer-name string (`taps.beer_ref`; the join is plain string equality,
  and `brewery_ref` is not part of the key and is unreliable here — name/brewery divergence
  is the whole reason we pin). If a shop reuses the **exact same** name string for a
  **different** beer later (e.g. next year's `Urodzinowe`), the pin goes stale and, because
  we skip re-matching, will not self-correct. This is not derivable from the data, and this
  coarseness pre-exists pinning (two beers sharing a name string already collide on one
  global `match_link` today — pinning only changes "last-writer-wins + self-heal" into
  "frozen"). Mitigated by revocability + auditability below, not by detection logic. YAGNI.
- No changes to the algorithmic matcher, curated brewery aliases, or the `A / B` retry
  hypothesis in the #343 body — by the user's read those cannot help this class.
- No extension surface. Nothing in `extension/**` changes; `docs/extension-install-uk.md`
  is untouched.

## Design

### 1. Ingest guard — revive `reviewed_by_user`

In the per-tap loop of `src/jobs/refresh-ontap.ts`, before `matchPrepared`/`upsertMatch`:

```ts
const pinned = getMatch(db, t.beer_ref);
if (pinned?.reviewed_by_user) continue;   // curated pin — never auto-rematch
```

`reviewed_by_user` gains exactly the live meaning the dead `markReviewed` intended:
"a human fixed this link; do not recompute it." `continue` is safe because:

- The tap row is already persisted by `insertTaps` **before** the loop, so skipping the
  match step loses nothing.
- The pinned target beer is a normal catalog row, loaded into `prepared` at job start, so
  it remains available for other taps to match.
- Ratings are refreshed on the **beer row** by the rating-refresh cron, independent of
  `match_links`, so a pinned link does not freeze its rating.
- The enrich-orphans cron only selects `untappd_id IS NULL` beers on tap; a merge-pin
  deletes the orphan and a same-row pin sets `untappd_id`, so pinned beers leave that pool
  naturally — no extra guard needed there.

### 2. Pin operation — `pinMatch` core + CLI

Core function in `src/` (compiles to `dist`, so it is prod-reachable per the
ops-tooling-reachability constraint), e.g. `src/domain/pin-match.ts`:

```ts
pinMatch(db, { beerId, untappdId }): PinResult   // PinResult describes 'merged' | 'set'
```

Behaviour, in one transaction:

- **Target bid already owned by a local canonical row `C` (`C.id !== beerId`)** — the
  merge case (33280 → 28831):
  - `UPDATE match_links SET untappd_beer_id = C.id, reviewed_by_user = 1
     WHERE untappd_beer_id = beerId;` (redirect **all** the orphan's links and pin them)
  - `DELETE FROM beers WHERE id = beerId;` (its `enrich_failures` CASCADE-drop)
  - The canonical row's own auto-derivable link is left untouched (`reviewed_by_user = 0`).
- **Target bid is new (no local owner)**:
  - `UPDATE beers SET untappd_id = untappdId, untappd_lookup_at = now WHERE id = beerId;`
  - `UPDATE match_links SET reviewed_by_user = 1 WHERE untappd_beer_id = beerId;`
  - `DELETE FROM enrich_failures WHERE beer_id = beerId;`
- Validates the beer exists; **idempotent** (re-running is a no-op).
- Bumps the catalog version (uses the same storage mutators, so `bumpCatalogVersion` fires).
- Metadata (`style`/`abv`/`rating_global`) is left `NULL` in the new-bid case — the
  rating-refresh cron backfills `rating_global` for on-tap matched beers (as it will for
  33238). We cannot fetch it locally (Untappd blocks the VPS/direct fetch).

Thin CLI wrapper `scripts/pin-match.ts` (`npm run pin-match`):

- `--beer <id> --untappd <url|bid>` — create a pin (bid parsed from an Untappd URL's
  trailing id or given directly).
- `--unpin (--ref <ontap_ref> | --beer <id>)` — set `reviewed_by_user = 0` on the matching
  link(s), returning the tap to normal matching/enrichment. The one-command undo for a
  stale pin. `--ref` is the reliable form for **merged** pins (the orphan row is gone; the
  pinned link lives on the canonical row and is addressed by its `ontap_ref`, e.g.
  `Urodzinowe`). `--beer` clears the flag on all of that beer's links and is the natural
  form for a **same-row** pin (whose orphan still exists).
- `--list` — dump all pins (`ontap_ref → beer → untappd_id`) for eyeball auditing.

### 3. Testing (TDD)

- **Ingest guard** (`refresh-ontap` test): a snapshot whose tap has a `reviewed_by_user = 1`
  link pointing at beer `X` still points at `X` after ingest, even when `matchPrepared`
  would return nothing or a different beer.
- **`pinMatch`**: merge case (redirects links, pins them, deletes orphan, clears failure);
  new-bid case (sets `untappd_id`, pins link, clears failure); idempotency; unknown-beer
  error.
- **CLI**: URL→bid parsing; `--unpin` clears the flag; `--list` output.

### 4. Rollout / housekeeping

- Pin `33280 → 28831` in prod via the tested code path (or the equivalent verified SQL run
  as the `warsaw-beer-bot` user), then confirm the link holds and `33280` is gone.
- Re-verify `33238` (already linked) shows a rating after the next refresh cron.
- Update `spec.md` (OpenSpec source of truth): document curated pins as a matcher behavior —
  `reviewed_by_user = 1` links are authoritative and never auto-rematched.
- Close #343 noting: 33238 linked, 33280 pinned, and the class now has a durable tool.

## Risks

- **Stale pin on same-string-different-beer** — see Non-goals; accepted, mitigated by
  `--unpin`/`--list`.
- **Catalog-cache staleness on out-of-band prod writes** — a raw prod pin does not bump the
  running process's in-memory `catalogVersion`; the `/match` cache refreshes on the next
  version bump (daily snapshot), consistent with the existing re-arm ops workflow.
