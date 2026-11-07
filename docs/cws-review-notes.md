# Chrome Web Store — review notes (Warsaw Beer Overlay)

> ⚠️ **Поле «Notes for reviewer» у дашборді має ліміт 500 символів.** Увесь цей
> документ туди не влізе (він ~2.3k) — це внутрішній довідник. У дашборд іде
> **лише** скорочений блок нижче; він тримається під лімітом навмисно, тож,
> дописуючи туди речення, перерахуй довжину. Обґрунтування кожного дозволу має
> свої окремі поля (`cws-listing.md` → «Permission justifications») і в цих 500
> символів не входить — не дублюй їх сюди цілком.

## Paste into the dashboard (≤500 chars)

```
To verify with no account: install, open https://onemorebeer.pl/ and browse a beer category. Cards get a grey badge at once; in ~2s gold-star Untappd ratings appear, a few at a time. Clicking one opens the beer on Untappd. Popup: "Works without Telegram".

Personal "already had it" badges come from "Sync my check-ins" (kept in the browser) or a token from our Telegram bot. untappd.com and *.algolia.net are optional, requested only for "find missing beers" / check-in sync.
```

## What the extension does

It overlays your personal Untappd status and ratings onto craft-beer shop pages
(BeerRepublic, OneMoreBeer, BeerFreak, Bierloods22, WineTime, Hoptimaal, Flasker,
Piwne Mosty, Funkyshop, Beershop). For each product it shows a badge:

- ⭐ + number — the beer's **global** Untappd rating.
- ✅ (+ your rating) — you have already checked this beer in (after "Sync my check-ins", or
  with a token).
- A dashed outline with `?` around either of those — a probable (fuzzy) match.
- A magnifier — the beer is known but has no linked Untappd id yet.
- Grey ring / spinning arc / reload arrow / triangle with `!` — the card is queued, is
  being checked, was not reached this time, or the check failed. These carry no colour.

## How to verify WITHOUT any setup (anonymous mode)

No account, login, or token is required to see the core feature:

1. Install the extension.
2. Open any supported shop, e.g. `https://onemorebeer.pl/` and browse to a beer
   listing/category page.
3. Every card gets a grey badge at once; within ~1–2s ⭐ rating badges appear on beers
   present in our catalog, a few cards at a time on a large page. Clicking a rating
   badge opens the beer (or an Untappd search) in a new tab.
4. Click the toolbar icon: without a token the popup says **"Works without Telegram"**,
   offers **"Sync my check-ins"** as its main button and **"Get a token"** below it. This
   is the expected state without an account — global ratings work fully.
5. *(optional, needs an Untappd login)* Press **"Sync my check-ins"** and grant access to
   untappd.com: the check-ins are kept in the browser's local database, and shop pages
   then show ✅ with your rating for beers you have had. The options page shows how many
   are stored and clears them with **"Clear local check-ins"**.

## Authorized mode (optional)

A token issued by the project's Telegram bot (`/extension` command) keeps the user's
history on the bot's server instead of the browser, which adds recommendations and sync
across devices. This is opt-in and not needed to review the core functionality.

## Permissions

- Host access to the supported shop domains — to read product names and inject
  rating badges.
- `untappd.com` + `*.algolia.net` are **optional** and requested only if the user
  enables "find missing beers" / check-in sync.

## Privacy

See the published privacy policy. Anonymous `/match` sends only shop product
names/breweries to the backend and returns public catalog ratings — no personal or
account data is involved unless the user adds a token. Check-ins synced without a token
stay in the browser and are never sent.
