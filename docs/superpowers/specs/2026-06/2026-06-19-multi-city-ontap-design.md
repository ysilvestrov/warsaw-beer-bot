# Multi-city ontap sync + `/city` command

**Issue:** #146 — "Add more Polish cities to the bot." Allow ontap cities other than
Warsaw to be synced, and add a `/city` command so a user picks which city's pubs they
browse.

**Decision summary (from brainstorming):**
- Supported cities are a **curated constant**, not dynamically discovered.
- Launch set = the biggest ontap.pl cities: **Warszawa, Kraków, Wrocław, Poznań,
  Trójmiasto, Łódź, Katowice** (exact ontap.pl slugs pinned against captured fixtures).
- Each user has **one active city**; everyone who never chose one (incl. all existing
  users) defaults to **Warszawa** — no behaviour change for current users.
- The Untappd catalog, drunk-status, ratings, the extension and the `/match` API stay
  **global / city-independent**. Only pubs/snapshots/taps are city-bound.
- New cities' beers are enriched by the existing rate-limited `enrich-orphans` cron, not
  by an inline burst (see §4) — bounded Untappd exposure.
- `/refresh` is **left unchanged** (its evolution is #144); it simply covers all cities
  now via the scraper, with no new city logic.

## Scope

In scope: tag pubs with a city, scrape multiple ontap city index pages, store a per-user
active city, scope the four pub-browsing commands to it, and add `/city`.

Out of scope: `/refresh` city-scoping (#144); per-city admin digests; a `cities` DB
entity / enable-disable-without-deploy (deferred — the constant can be promoted later);
multi-city / "all cities" selection.

## Architecture

Additive. Three moving parts:
1. **Ingest** — `refreshOntap` loops a curated city list and tags each pub's `city`.
2. **State** — `pubs.city` + `user_profiles.city` columns.
3. **Read** — the four pub commands resolve the user's city and filter `listPubs` by it;
   new `/city` sets it.

The single scoping injection point per command is already verified:
`newbeers-build.ts:58`, `route.ts:51`, `beers-build.ts:32`, `pubs-build.ts:12` — each
builds its working set from `listPubs(db)`.

## 1. City config — `src/domain/cities.ts` (new)

```ts
export interface City { slug: string; label: string; }

// Curated; slugs are the ontap.pl city-index path segments (ontap.pl/<slug>),
// pinned against captured fixtures during implementation.
export const CITIES: readonly City[] = [
  { slug: 'warszawa',   label: 'Warszawa' },
  { slug: 'krakow',     label: 'Kraków' },
  { slug: 'wroclaw',    label: 'Wrocław' },
  { slug: 'poznan',     label: 'Poznań' },
  { slug: 'trojmiasto', label: 'Trójmiasto' },
  { slug: 'lodz',       label: 'Łódź' },
  { slug: 'katowice',   label: 'Katowice' },
];

export const DEFAULT_CITY = 'warszawa';

const SLUGS = new Set(CITIES.map((c) => c.slug));
export function isKnownCity(slug: string): boolean { return SLUGS.has(slug); }
export function cityLabel(slug: string): string {
  return CITIES.find((c) => c.slug === slug)?.label ?? slug;
}
```

Single source of truth for the scraper, the `/city` menu, and slug validation.

> **Implementation note:** the exact slugs above are the expected ontap.pl path
> segments; confirm each by capturing `ontap.pl/<slug>` before finalizing (a wrong slug
> yields an empty index, not an error). Adjust the constant if any differs.

## 2. Schema — migration v14

```sql
ALTER TABLE pubs ADD COLUMN city TEXT NOT NULL DEFAULT 'warszawa';
ALTER TABLE user_profiles ADD COLUMN city TEXT;
CREATE INDEX idx_pubs_city ON pubs(city);
```

- `pubs.city` is `NOT NULL DEFAULT 'warszawa'` so every existing pub backfills to Warsaw
  and every future insert always has a city.
- `user_profiles.city` is **nullable**: `NULL` = "never chose" → resolves to
  `DEFAULT_CITY` in code. No data migration for existing users.

## 3. Storage

**`src/storage/pubs.ts`**
- Add `city: string` to `PubInput` (and `PubRow`).
- `upsertPub` writes `city` on both INSERT and UPDATE.
- `listPubs(db, city?: string)`: when `city` is provided, `... WHERE city = ? ORDER BY
  id`; no-arg form unchanged (returns all) for back-compat.

**`src/storage/user_profiles.ts`**
- `getUserCity(db, telegramId): string` — returns the stored city **only if** it is a
  known slug, else `DEFAULT_CITY` (defends against a slug later removed from the
  constant).
- `setUserCity(db, telegramId, slug)` — `UPDATE user_profiles SET city = ?`.
- Add `city` to `ProfileRow`.

## 4. Scraper — `src/jobs/refresh-ontap.ts` + `src/sources/ontap/index.ts`

- Rename `parseWarsawIndex` → `parseOntapCityIndex` (identical implementation; the
  selector `div[onclick*=".ontap.pl"]` is site-wide). Update the import.
- `refreshOntap` loops the city list. For each city: `GET https://ontap.pl/<slug>`,
  parse, and tag every pub from that page with `city: slug` via `upsertPub`. Per-city
  progress (`🍻 ontap <city>: i/n …`). The list comes from a new optional
  `cities?: readonly City[]` dep defaulting to `CITIES` (so tests inject a small set
  against fixtures; prod uses the constant).
- **Per-city isolation:** wrap each city's index fetch+loop in try/catch; a failed city
  is logged (`log.warn`) and skipped so it cannot abort the others (mirrors the existing
  per-pub guard).
- **Inline-enrich budget (the "lean on cron" decision):** a single integer budget per
  `refreshOntap` invocation, default **20**, shared across *all* cities in that run.
  Inline `enrichOneOrphan` fires for fresh orphans only while the budget remains;
  decrement on each inline enrich that actually runs (outcome !== 'skipped'); once the
  budget hits 0, fresh orphans are created but **not** inline-enriched — the
  `enrich-orphans` cron drains them. This preserves Warsaw's steady-state low latency
  (a few new beers/run stay under budget) while capping the first multi-city seeding
  burst at ~20 Untappd calls regardless of city count.
  - Add `inlineEnrichBudget?: number` to `Deps` (default 20). The existing `lookupEnabled`
    / `lookupSleepMs` semantics are unchanged; the budget gates *in addition* to
    `lookupEnabled && isFreshOrphan`.

`filterIndexBySlugs` (scoped `/refresh` by pub slug) keeps working: it filters the parsed
index per city; a scoped slug simply matches in whichever city's index contains it.

> **Assumption to validate:** other cities' index pages share Warsaw's DOM template, so
> `parseOntapCityIndex` generalizes. Validated by a captured non-Warsaw fixture (§7).

## 5. `/city` command — `src/bot/commands/city.ts` (new), mirrors `/lang`

- `cityCommand.command('city', …)`: `ensureProfile`, then reply with `city.prompt`
  (naming the current city via `cityLabel(getUserCity(...))`) and `cityKeyboard(current)`.
- `cityCommand.action(/^city:([a-z-]+)$/, …)`: read the slug; if `!isKnownCity(slug)`,
  `answerCbQuery` and return (ignore stale/unknown); else `setUserCity`,
  `editMessageText(city.changed, { name: cityLabel(slug) })`, `answerCbQuery`.
- `cityKeyboard(current)` in `src/bot/keyboards.ts`: one inline button per `CITIES`
  entry, callback data `city:<slug>`, the active one prefixed `✓ ` (label only otherwise).
- i18n keys `city.prompt` and `city.changed` (with `{name}`) added to **uk/pl/en**
  locale files.
- Register `cityCommand` in `bot.use(...)` (alongside `langCommand`); add `/city` to the
  `help` text, the bot command list, and `/start`.

## 6. Command scoping

Each build resolves `const city = getUserCity(db, telegramId)` and calls
`listPubs(db, city)` at its single injection point:
- `pubs-build.ts:12`, `route.ts:51`, `beers-build.ts:32`, `newbeers-build.ts:58`.

`telegramId` is already available in each command handler. Empty result (a city with no
pubs yet) flows through the existing empty/`no pubs`/`pub_not_found` branches unchanged —
no new "empty city" UX required. Ranking, filters, formatting are untouched.

## 7. Testing

- **`cities.ts`**: `isKnownCity` true/false; `cityLabel` known + fallback; `DEFAULT_CITY`.
- **`parseOntapCityIndex`**: existing Warsaw fixture still parses; a **new captured
  non-Warsaw fixture** (e.g. `tests/fixtures/ontap-krakow-index.html`) parses pubs —
  proves the DOM generalizes.
- **storage**: `upsertPub` persists `city` (insert + update); `listPubs(db, 'krakow')`
  returns only that city; `getUserCity` returns default when unset / when stored slug is
  unknown, stored slug when known; `setUserCity` round-trips.
- **`refreshOntap`** (stub `http` keyed by URL, multi-city fixtures): pubs tagged with the
  correct city; a city whose index fetch throws is skipped while others succeed; inline
  enrich invoked at most `inlineEnrichBudget` times across the run.
- **`/city`**: `command` replies with a keyboard marking the current city; `action` with a
  known slug calls `setUserCity` + edits the message; `action` with an unknown slug does
  not write.
- **scoping**: with two pubs in different cities and a user on city A, each of `/pubs`,
  `/newbeers`, `/route`, `/beers` excludes the city-B pub.

## 8. Spec & docs

- Update **`spec.md`**: ontap multi-city ingest, the `city` columns (schema_version 14),
  the four city-scoped commands, and the new `/city` command.
- No `extension/**` change → **`docs/extension-install-uk.md` not touched**.
- Update help text / bot command list / `/start` to include `/city`.

## Risks / edge cases

- **Wrong city slug** in the constant → empty index, no crash; caught by the capture step.
- **A city removed from the constant later** while a user is on it → `getUserCity` falls
  back to `DEFAULT_CITY` (validation guard); their old pubs remain in the DB but are
  unreachable via the scoped commands (acceptable; cleanup is out of scope).
- **Scrape duration** grows ~linearly with city count (more pub-page fetches against the
  public, ban-free ontap.pl). 12h cadence absorbs it; per-city isolation prevents one
  slow/failed city from blocking the rest.
