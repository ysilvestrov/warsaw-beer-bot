# #612: honest sync status and profile ratings

Status: approved by the user on 2026-09-28 (check-in rating takes priority).

## Scope

Fix `/status` implying current completeness from two historical counters. Persist
the personal ratings that the daily `/user/<username>/beers` scrape already parses,
and make them available through existing personal-rating consumers.

## Status behavior

- Keep the synced check-in count and the last observed profile total, but remove
  the completeness checkmark. Equal counters do not establish current coverage.
- Show the time of the last extension sync from `checkin_sync_state.updated_at`.
  When no sync has occurred, say so explicitly.
- Explain that the profile total is from the last sync, not a fresh Untappd count.
- Count beers known through `untappd_had` but absent from the user's `checkins`.
  When nonzero, report that the server knows these beers but their check-ins have
  not been imported, and suggest “Sync my check-ins”. Do not claim when they were
  consumed or that this is the number of missing check-ins.
- No arbitrary freshness threshold and no Untappd request from `/status`.
- Translate additions into all existing bot locales.

## Rating behavior

- Add a nullable personal-rating column to `untappd_had`, with existing rows
  remaining NULL until a successful scrape supplies a value.
- Persist a finite, valid personal rating in the 0–5 range for the profile owner
  and the exact beer resolved by Untappd bid. Zero is valid for personal ratings;
  the global-rating rule “zero means unavailable” does not apply.
- Missing, malformed, or unavailable rating data must not erase a previously
  observed personal rating. A blocked or failed scrape writes no rating.
- Keep the existing latest non-null check-in rating as the first choice. Use the
  scraped profile rating only when there is no non-null check-in rating for that
  user and beer. This gives had-only beers a rating without equating a profile
  beer rating with the rating of a particular check-in.
- Apply this fallback through the shared personal-rating reader, so Telegram beer
  lists, extension `/match`, and MCP use the same rule. Preserve exact-match gates.
- Do not create synthetic check-ins, change sync counters, or record coverage
  from the profile scrape. Do not place personal ratings in the global catalogue.
- Preserve existing identity-reset and beer-merge behavior for had rows, including
  their new rating field; prevent ratings crossing users or linked accounts.
  The existing account setter does not reset history (#611 is separate). Clear
  only the new profile rating field when the linked username changes, and ignore
  a scrape response whose profile owner changed while the request was in flight.
  Keep existing check-in/account history behavior outside this change.

## Claims and evidence

| Recorded fact or displayed claim | What establishes it | Limit |
| --- | --- | --- |
| Stored check-in count | Rows in `checkins` for this user | Says nothing about new or deleted remote check-ins |
| Observed profile total | Profile HTML from the last sync | Historical observation, not today's total |
| Last sync time | Existing sync-state write timestamp | Does not establish completeness |
| Beer was tried | Profile's `/beers` card and its bid | No check-in ID or consumption timestamp |
| Profile personal rating | `Their Rating` numeric value on that profile's beer card | Not assumed to be latest individual check-in rating |
| Last observed time | Time of the successful scrape | Observation time, not drinking time |
| Known beer absent from imported check-ins | Per-user anti-join of had rows against check-ins | Evidence of a source discrepancy, not its date or missing check-in count |
| Effective personal rating | Latest non-null check-in rating; otherwise stored profile rating | Can remain stale; priority is explicit rather than inferred from scrape time |

Evidence before design: the existing real HTML fixture contains `Their Rating`,
and parser tests assert both personal and global ratings. The refresh path
discards the personal rating; had storage has no rating field. The check-in
reader supplies all current personal ratings. A read-only production DB query
on 2026-09-28 found 12634 stored check-ins and the same observed total, a last sync
at 2026-09-03 22:19:05, and 53 had beers absent from check-ins. A fresh direct
Untappd probe returned HTTP 403, so current live HTML was not verified.

## Alternatives

1. Recommended: remove unsupported completeness claims, expose historical times
   and source discrepancies, and add profile ratings as a fallback.
2. Pick ratings by observation time: rejected because observing a profile beer
   rating today does not prove it represents a later check-in.
3. Obtain fresh profile totals on every status request: adds network dependency
   and does not establish check-in coverage even with equal counts.

## Verification and delivery

Core first: schema, scrape persistence, and shared rating fallback with focused
tests for NULL, zero, invalid inputs, updates, user isolation, and check-in
priority. Review the whole core before planning status presentation and adjacent
paths. Verify account reset and beer merges, status with and without sync state,
source discrepancies, and unchanged counts/coverage after scraping.

Run `npm test` and `npm run typecheck`, then review the complete branch. Update
`spec.md` to document the final contracts. If extension users gain visible
personal ratings, add the required user-facing extension changelog and install
guide entries. PR creation remains a separate user decision.
