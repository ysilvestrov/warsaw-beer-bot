# Design: Role-aware `/refresh` scoping

**Issue:** #144 — Enhance `/refresh` behavior

## Goal

Make `/refresh` refresh only the pubs and Untappd profiles relevant to the caller,
while preserving the administrator's ability to run a global refresh.

The command scope depends on three inputs:

- whether the caller's Telegram ID equals `ADMIN_TELEGRAM_ID`;
- the caller's active city (`getUserCity`);
- the optional command argument.

## Command behavior

| Caller and command | Ontap scope | Untappd scope |
|---|---|---|
| Admin `/refresh` | All curated cities and all pubs | All linked profiles |
| Admin `/refresh me` | All pubs in the admin's active city | Admin's profile only |
| Admin `/refresh <query>` | Matching pubs across all cities | All linked profiles |
| Non-admin `/refresh` | All pubs in the caller's active city | Caller's profile only |
| Non-admin `/refresh <query>` | Matching pubs in the caller's active city | Caller's profile only |

`me` is reserved only as an exact, case-insensitive admin argument after trimming.
For non-admin callers it remains an ordinary pub query.

Pub queries reuse `filterPubsByQuery`: case-insensitive name matching first, then
word matching against the combined pub name and address. Admin queries search the
stored pubs from every city; non-admin queries search only pubs in the caller's
active city. Multiple matches are all refreshed. No match returns the existing
localized `newbeers.pub_not_found` response without claiming a cooldown or starting
background work.

## Scope resolution

Keep role and argument decisions in a pure command-layer resolver. It receives the
database, caller Telegram ID, configured admin ID, active city, and raw argument,
then returns either:

- a runnable scope containing optional city and pub restrictions, the target
  Telegram profile IDs, and whether the operation uses the full or scoped
  cooldown; or
- `pub_not_found` with the original trimmed query.

The handler remains responsible for replies, cooldown state, progress tracking,
and starting the fire-and-forget pipeline. Comparing administrator identity uses
string values (`String(ctx.from.id) === ADMIN_TELEGRAM_ID`) because the environment
schema stores the configured ID as a string.

## Job changes

### Ontap refresh

`refreshOntap` already accepts `pubSlugs` and `cities`. The command pipeline will
pass:

- neither restriction for the admin's global refresh;
- one `City` for city-wide refreshes;
- `pubSlugs` plus the appropriate city list for query refreshes.

The scheduled job continues to omit both restrictions and therefore keeps its
existing all-city behavior.

### Untappd refresh

Add an optional Telegram-ID filter to `refreshAllUntappd`. When present, it filters
`allProfiles(db)` before retaining profiles with an Untappd username. An absent
filter means all profiles, preserving cron and admin-global behavior.

An empty or unlinked selected profile is a successful zero-profile refresh, matching
the current job's behavior for an empty global profile list. If the cookie-backed
Untappd client is unavailable, the command still completes the Ontap work and skips
profile refresh as it does today.

## Post-refresh results

Query-based refreshes keep the current follow-up `/newbeers` result. The follow-up
uses the exact matched pub set rather than resolving the query again:

- a non-admin query naturally stays inside the active city;
- an admin query can display results from every matched pub, including pubs outside
  the admin's active city.

City-wide and global refreshes do not send an additional `/newbeers` message.

## Cooldowns

Keep the existing per-caller cooldown maps and messages, but classify the resolved
operation by cost:

- **5 minutes:** admin global, admin `me`, admin query (all profiles), and non-admin
  city-wide refresh;
- **30 seconds:** non-admin query, where both pubs and profiles are scoped.

Not-found queries do not stamp either cooldown. Full and scoped cooldown maps remain
independent.

## Progress and errors

The command remains fire-and-forget so it cannot hit Telegraf's handler timeout.
It keeps the current active-progress tracking, throttled edits, final
`refresh.done`, and `refresh.failed` behavior.

Per-city and per-pub Ontap failures continue to be logged and skipped by
`refreshOntap`. Untappd profile failures continue to be handled per profile by
`refreshAllUntappd`; cookie expiry and circuit-breaker behavior remain unchanged.
No new user-facing translations are required.

## Tests

Add focused tests before implementation for:

- all five rows of the command behavior matrix;
- case-insensitive admin `me` and non-admin `me` as a normal pub query;
- admin query matching pubs across multiple cities by name or address;
- non-admin query excluding matching pubs outside the active city;
- multiple pub matches and the no-match result;
- cooldown classification for each resolved operation;
- filtered `refreshAllUntappd` processing only selected Telegram IDs;
- absent Untappd filtering preserving all-profile cron behavior;
- explicit matched-pub follow-up results across city boundaries.

Existing refresh, cron, progress, failure, circuit-breaker, and city-scoping tests
must continue to pass.

## Specification updates

Update `spec.md`'s `/refresh` section to replace the current full/scoped description
with the role-aware matrix, query matching semantics, and cost-based cooldown rules.
The background-job section remains unchanged except for documenting the optional
per-user filter used by command-triggered Untappd refreshes.

## Out of scope

- Changing scheduled refresh scopes or schedules.
- Adding new administrator roles or an administrator list.
- Persisting cooldowns across process restarts.
- Discovering previously unknown pubs from a query; pub query resolution continues
  to use the stored pub catalog.
- Changing `/newbeers`' normal active-city behavior outside the explicit post-refresh
  matched-pub scope.
