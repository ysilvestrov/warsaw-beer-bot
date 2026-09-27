# #716: Recover a cached orphan after the server links it

## Evidence

On 2026-09-27, the River North page made four `/match` requests at 18:17:04 and
18:18:03 UTC. Four rows gained Untappd IDs at 18:17:02, :05, :09 and :13. The
captured second response had the first ID but returned the other three as
orphans. `/enrich/candidates` reported those three as ineligible because the
database already held their links. A normal reload kept the search badges;
"Refresh this page", which clears the extension cache, restored the ratings.

## Decision

1. A catalog version change makes `/match` wait for the shared catalog rebuild.
   A TTL-only expiry may continue to serve stale data while rebuilding. The
   rebuild stays single-flight. A failed rebuild fails the request instead of
   claiming an outdated catalog is current.
2. `/enrich/candidates` adds optional `linked: true` only for an ineligible
   card whose selected row is already linked and has no contradictory published
   bid or active not-a-beer/disposition veto. Existing clients ignore the field.
3. The extension batches linked candidates into one authenticated `/match`
   request with the original shop facts. Only a response with a real Untappd ID
   can replace the cached orphan. The replacement uses the existing conditional
   cache write; a concurrent clear or newer answer wins. The badge renders the
   full `/match` result, preserving drunk state and personal rating. Failed,
   short, or still-unlinked rechecks keep the prior fallback badge. No extra
   Untappd search is made for linked candidates.

## Claims and evidence

| Recorded fact | Proof required |
| --- | --- |
| The process catalog snapshot is current for a version | A successful rebuild from `loadCatalog`/`loadAliases` at that version; `get()` awaits it after a version change. |
| A candidate is already linked | The live `beers.untappd_id` on the selected row, with the existing disposition, not-a-beer and bid guards. |
| A browser cache entry now names a linked beer | A fresh `/match` response with `matched_beer.untappd_id`, written only if the old cache entry still matches. |

## Boundaries and verification

Do not change the Untappd search budget, backoff or public badge meanings.
Cover the version-change read barrier, TTL-only behavior, linked candidate
signal, cached-orphan recovery, stale write race and no-result fallback.
Check the response change with older clients and run both server and extension
test/typecheck gates. Update the user-facing extension changelog for the
observable badge fix.
