# ontap non-beer filtering: cocktails, wine, kombucha, schedule pollution (GH #208)

**Date:** 2026-06-26
**Issue:** #208 — *ontap: filter cocktail, wine, kombucha, and schedule pollution rows*

## Problem

Server/ontap rows that are obviously non-beer (cocktails, wine, kombucha) or
parser pollution (schedule/navigation strings) slip past `isOntapNonBeerTap` and
become catalog orphans that fail enrichment. They are not matcher failures.

Real rows from prod (`beers` + `enrich_failures`):

| brewery | name | style |
|---|---|---|
| Nalej Se Brewery | Mai Tai / Bramble / Jagermeister Orange Sunrise | `Cocktail` |
| Nalej Se Brewery | Nalewka gruszkowa | `Nalewka` |
| Nalej Se Brewery | Big Diva | `Szprycer` |
| Koko Kombucha Brewery | Imbir | `Kombucha` |
| Cantina della Valle | Vino Bianco Frizzante | `Chardonnay, Glera and Garganega` |
| Aperitivo Spritz / Aperitivo Spritz Brewery | Aperitivo Spritz / Aperol Spritz | (null) |
| Cantina della Valle Brewery | Glera Trevenezie | (null) |
| Basement -> Czwartek-Sobota od 18.00 Brewery | Bar | (null) |

## Key design decision: style + brewery only, no name inspection

The classifier deliberately inspects only `style` and `brewery_ref`, never the
beer name (`beer_ref`). An explicit test (`non-beer.test.ts` "does not inspect
beer_ref/name") locks this in: a tap named `Vino Merlot Spritz Prosecco` stays
eligible, because real beers can carry wine/style words in their names.

The prod data shows **every** #208 row is catchable via `style` or `brewery_ref`
alone (most carry a diagnostic style; the styleless ones have a diagnostic or
polluted brewery). So we extend the existing token sets and add one brewery guard
— and keep the no-name-inspection invariant fully intact. This is strictly more
conservative than the issue's literal "cocktail name sentinels" proposal, where an
exact name like `Bramble` could collide with a real fruit-beer name.

`OntapNonBeerInput` and the function signature are unchanged.

## Changes to `src/sources/ontap/non-beer.ts`

1. **`STYLE_TOKENS` add:** `cocktail` (English; `koktajl` already present),
   `nalewka`, `szprycer`, `kombucha`, `glera`.
   - Catches: all `Cocktail`/`Nalewka`/`Szprycer`/`Kombucha` rows and the
     `…, Glera and …` wine-grape style.
2. **`BREWERY_TOKENS` add:** `aperitivo`, `cantina`, `kombucha`.
   - `aperitivo` catches `Aperitivo Spritz Brewery` (the existing exact sentinel
     `aperitivo spritz` misses it because of the ` Brewery` suffix).
   - `cantina` (singular) catches `Cantina della Valle` / `Cantina della Valle
     Brewery` (`cantine` plural already present).
   - `kombucha` catches `Koko Kombucha Brewery` when its row has a null style.
3. **Schedule/navigation pollution guard** on `brewery_ref` — non-beer when the
   brewery contains `->` (breadcrumb/nav arrow) or an opening-hours time range
   matching `/\bod\s+\d{1,2}[.:]\d{2}\b/` (e.g. `od 18.00`). Catches
   `Basement -> Czwartek-Sobota od 18.00 Brewery`.

### Evaluation order (unchanged precedence)

`isOntapNonBeerTap` keeps its current order so the false-positive guards win:

1. **Eligible first:** if `style` matches `ELIGIBLE_STYLE_TOKENS`
   (cider / kvass / `квас` / mead / melomel) → **eligible** (return false).
   - `kombucha` does not contain `kvass`/`квас`/`kwas chlebowy`, so the new
     kombucha rules never collide with the kvass guard (verified). The existing
     `Квас` + `Stacja Winiarska` / `Dolium Vini` tests still return eligible
     because the eligible check precedes the brewery check.
2. **Style non-beer:** `EXACT_STYLE_PHRASES` or `STYLE_TOKENS` (incl. new tokens).
3. **Brewery non-beer:** `EXACT_BREWERY_SENTINELS` or `BREWERY_TOKENS`
   (incl. new tokens) **or** the new schedule/nav guard.
4. Else eligible.

## Testing

Add to `src/sources/ontap/non-beer.test.ts`:

- **Filtered (true):** one case per #208 row, each with the real style/brewery
  from the table above — e.g. `{ style: 'Cocktail', brewery_ref: 'Nalej Se
  Brewery', beer_ref: 'Mai Tai' }`, `{ style: 'Kombucha', brewery_ref: 'Koko
  Kombucha Brewery' }`, `{ style: null, brewery_ref: 'Aperitivo Spritz Brewery' }`,
  `{ style: null, brewery_ref: 'Basement -> Czwartek-Sobota od 18.00 Brewery' }`,
  `{ style: null, brewery_ref: 'Cantina della Valle Brewery' }`.
- **Still eligible (false), regression:** all existing cider / kvass / mead /
  normal-beer cases, plus the `does not inspect beer_ref/name` invariant case
  (`Vino Merlot Spritz Prosecco`) — must stay green, proving no name inspection
  and no eligible-guard breakage.

## Out of scope

- No name (`beer_ref`) inspection.
- Extension/adapter non-beer filters (`extension/**`) — #208 is the ontap server
  path only; adapters have their own `isNonBeerName`.
- No purge of already-present rows here (separate read-only-reviewed DB op per the
  orphan runbook, after deploy).

## Spec & docs obligations (CLAUDE.md)

- Update `spec.md` non-beer filtering note if it enumerates the token classes.
- No `extension/**` user-facing change → no `docs/extension-install-uk.md` update.
