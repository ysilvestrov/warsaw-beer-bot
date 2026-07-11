# Browser extension "Warsaw Beer Overlay" — install & setup

The extension overlays your personal **"already had it"** status and **your
rating** on craft beer shop pages, for every beer that matches your Untappd
history. Works on:

- `beerrepublic.eu` (and subdomains, e.g. `www.beerrepublic.eu`)
- `onemorebeer.pl` (and subdomains)
- `beerfreak.org` (and subdomains)
- `bierloods22.nl` (and subdomains)
- `winetime.com.ua` (and subdomains)
- `hoptimaal.com` (and subdomains)
- `flasker.com.ua` (and subdomains)
- `piwnemosty.pl` (and subdomains)
- `funkyshop.pl` (and subdomains)

To get everything working you need three things: (1) upload your beer
history to the bot, (2) get an access token, (3) install and configure the
extension. Step by step below.

### What you see without a token

The extension works even **without a token**: shop pages show **global
Untappd ratings** (⭐ badge) and links to the beer/search. This lets you see
right away how it works.

Personal features are unlocked by a **token** (Part 2): a ✅ "you already had
this" badge with **your own** rating, a ❓ for likely matches, plus searching
for missing beers and check-in syncing. The extension popup will show "Not
connected" (English UI) until a token is added.

---

## Prerequisites

- A Chromium-based browser: **Chrome, Edge, Brave, or Opera** (MV3 extension format).
- An **Untappd** account with check-in history (Supporter recommended — so you can export your history).
- _Node.js is only needed for developers building from source (see the note in Part 2)._

---

## Part 1. Register in the bot and import your beer list

This is done **once** in the Telegram bot. It's your Untappd history that
gives the extension the data on what you've already had (without it, no
badges will appear).

### 1.1. Start the bot and pick a language

1. Open the bot in Telegram, send **`/start`**.
2. Change the language if needed: **`/lang`**.

### 1.2. Link your Untappd account

Send:

```
/link <username>
```

where `<username>` is your Untappd handle (a full URL
`untappd.com/user/<username>` also works). Reply: `✅ Linked to
untappd.com/user/<username>`.

### 1.3. Import your beer history — this is your "beer list"

1. Send the **`/import`** command.
2. The bot will ask for an Untappd export file: **CSV, JSON, or ZIP (up to 20 MB)**.
3. Where to get the export: in Untappd → **Supporter → Account → Download History**.
   - If the JSON is large (> 20 MB) — **zip it** (compresses roughly 10×)
     and send the ZIP: Telegram won't let the bot download a file larger than 20 MB.
4. Send the file to the bot as a **document** (attachment, not text).
5. The bot will show progress and finish with: `✅ Imported N check-ins`.

After this, the bot knows exactly what you've had and how you rated it —
the extension will use this.

> You can update your history any time by sending a new export via `/import`.

### 1.4. Get an access token for the extension

Send:

```
/extension
```

The bot will reply with instructions and a token in a copyable block
(`<code>…</code>`), plus the **API address**.

> **Important:** the token rotates **1:1** — every `/extension` call creates
> a new token and **invalidates the previous one**. If you ever run
> `/extension` again, don't forget to update the token in the extension
> settings.

Copy the token — you'll need it in Part 3.

---

## Part 2. Install the extension

> 🏪 **Coming soon — Chrome Web Store.** The extension has been submitted to
> the Chrome Web Store (under review). **Once it's approved, the
> recommended way will be to install it from the store**
> (`https://chromewebstore.google.com/detail/fdelmnhijeiojadcaihfdpecfcldbndg`)
> — it will then update **automatically**. The store version has a
> **different ID**, so after switching from the store you'll have to
> **re-enter the token** in Options and remove the unpacked version. While
> the review is in progress (transition period) — use the method below
> (unpacked, via the bot).

The bot itself provides the extension — building from source is **not
required**.

### 2.1. Get the zip

Send **`/extension`**. The bot will send the token (Part 1.4) **and a file**
`warsaw-beer-overlay-<version>.zip`. Save it and **unpack it into a
permanent folder** (e.g. `~/warsaw-beer-overlay/`) — this is the folder
you'll load into the browser, and the one you'll update in place.

### 2.2. Load it into the browser (Chrome example)

1. Open **`chrome://extensions`** (in Edge — `edge://extensions`, Brave — `brave://extensions`).
2. Turn on **"Developer mode"** (toggle in the top right).
3. Click **"Load unpacked"**.
4. Select the folder you unpacked the zip into.

The extension will appear in the list. Pin its icon to the toolbar
(optional, but handy).

### 2.3. Updating

When a new version comes out, the bot will send a new zip on its own.
**Unpack it over the same folder** (overwriting it) and click **↻** on the
extension's card in `chrome://extensions`. The token and settings will be
preserved — the extension ID is fixed.

> **For developers: building from source.** If you want to build it
> yourself: `cd extension && npm install && npm run build` → load
> `extension/dist/`. `npm run package` additionally packs `dist/` into a zip.

---

## Part 3. Configure the extension

1. Open the extension's settings page:
   - right-click the extension icon → **"Options"**, or
   - `chrome://extensions` → on the extension's card → **"Details" → "Extension options"**.
2. Paste the token you got from the bot (`/extension`) into the **"Token"** field.
3. Leave the **"API URL"** field at its default:
   `https://beer-api.ysilvestrov-ai.uk`
   (change it only if you're running your own API instance).
4. _(Optional)_ Check **"Find missing beers via Untappd (uses your Untappd
   session)"** — then the extension will **search** for beers not yet in the
   bot's catalog, **using your own Untappd session/IP**: the bot returns the
   search parameters, and the extension makes a browser request to
   Untappd's public Algolia API and sends the bot only the resulting JSON
   candidates. Search is limited to a few requests per page, respecting
   anti-ban limits. The browser will ask for permission to access
   `untappd.com` and `*.algolia.net` — allow it.
   **Off** by default.
5. Click **"Save"**.
   - If you changed the URL to a non-default one, the browser will ask for
     permission to access that host — allow it, otherwise the extension
     won't be able to reach the API.
6. Click **"Test connection"**:
   - **✅ Connected** — all good.
   - **❌ Failed (health)** — API/URL unreachable (check the address and your internet connection).
   - **❌ Failed (unauthorized)** — wrong or expired token (run `/extension` again).
   - **❌ Failed (network)** — the browser couldn't reach the API: no
     permission for the host (for a non-default URL) or no network.
   - **❌ Failed (server)** — a temporary server error, try again later.

---

## Part 4. Using it

1. Go to a supported shop:
   `beerrepublic.eu`, `onemorebeer.pl`, `beerfreak.org`, `bierloods22.nl`,
   `winetime.com.ua`, `hoptimaal.com`, `flasker.com.ua`, `piwnemosty.pl`
   or `funkyshop.pl`.
2. The extension **automatically** reads the beer grid on the page, sends it
   to the bot for matching, and draws a **corner badge** on the cards. What
   the badges mean:

   | Badge | What it means |
   |---|---|
   | **✅** (with a rating, e.g. `✅ 4.2`) | you've **already had** this beer — shows **your** rating; **click opens Untappd** (or a search, if there's no Untappd page yet) |
   | **❓** (with a rating, e.g. `❓ 4.1`) | you've **likely** already had this beer, but the match is fuzzy; shows the **global** rating (if available); **click opens Untappd** to check (or an Untappd search, if there's no Untappd id yet) |
   | **⭐** (with a rating, e.g. `⭐ 4.1`) | you haven't had it yet, the beer is on Untappd — shows the **global** rating; **click opens Untappd** |
   | **⚪** | the beer is matched as an orphan (no Untappd page/rating yet); **click opens an Untappd search** pre-filled with the name |
   | **⏳** | a search on Untappd is in progress (only if "Find missing beers…" is enabled — Part 3, step 4) |
   | _(no badge)_ | the beer couldn't be matched to the catalog |

3. This also works with SPA navigation: when the shop re-renders the list
   (filters, pagination), the overlay updates itself.

> **✅ + your rating** only appear for beers from your own history (requires
> `/import`, Part 1). The **⭐ global rating** is also shown for beers you
> haven't had yet, if they're already in the bot's catalog. **❓** — a beer
> that's likely from your history, but the match is fuzzy: check it on
> Untappd (click the badge).

### The toolbar button (popup)

Clicking the extension's icon on the browser toolbar opens a small menu:

- **"Refresh this page"** — resets the overlay cache for the **current**
  page and redraws the badges (handy if the shop loaded new items, or you
  just ran `/import`).
- **"Clear all cache"** — clears the **entire** local overlay cache (all sites).
- **"Sync my check-ins"** — pulls in your check-ins from Untappd (see below).

### "Sync my check-ins" — sync check-ins without Supporter

The **"Sync my check-ins"** button in the popup loads your check-in history
**directly from your Untappd session** in the browser and sends it to the
bot — this is an alternative to `/import` that does **not require** Untappd
Supporter.

- **Prerequisite:** first link your account in the bot — `/link <username>`.
  Without this the button will show "Link your Untappd account in the bot
  first (/link)".
- **The first time**, the browser will ask for permission to access
  `untappd.com` (to read your feed within your session) — click
  **Allow**. If you decline, you'll see "Allow access to untappd.com to
  sync your check-ins." and the sync won't start.
- **What it does:** pages through your check-in feed from newest to oldest
  and uploads to the bot the ones it doesn't have yet. Progress is shown
  right there: `Syncing… 1200 / 8200`.
- **Multiple runs for a large history:** a single run loads a limited
  number of pages. If you have a lot of check-ins, you'll see **"Synced
  5000 of 8200 — tap Sync again to continue."** — just click **"Sync my
  check-ins"** again; each subsequent run **continues deeper**, rather than
  starting over. Once everything is loaded — **"✓ Fully synced"**.
- **Who needs this:** Supporters — to quickly top up new check-ins (e.g.
  after a festival where you tried 30+ beers in a day, but the background
  server sync only picks up 25); non-Supporters — to upload their history
  at all.
- If Untappd starts rate-limiting requests, you'll see **"Untappd is
  rate-limiting — try again later."**; just try again later (what's already
  been uploaded won't be lost).

---

## Troubleshooting

| Symptom | What to do |
|---|---|
| `Test connection` → **health** | Check the "API URL" field and your internet/tunnel access. |
| `Test connection` → **unauthorized** | The token expired or is wrong. Run `/extension`, paste the new token, **Save**. |
| `Test connection` → **network** | The browser couldn't reach the API: for a non-default URL, grant permission for the host (**Save** again, or `chrome://extensions → Details`); check your network. |
| Badges don't appear | 1) Are you on a supported site from the list above? 2) Have you run `/import`? 3) Reload the page. |
| Ran `/extension` again — it stopped working | The old token was invalidated. Paste the **new** token in the settings and **Save**. |
| Changed the API URL — it's not fetching | During **Save** the browser asks for host permission — allow it (or add the permission via `chrome://extensions → Details`). |

---

## In short (quick start)

1. In the bot: `/start` → `/link <username>` → `/import` (send your Untappd export) → `/extension` (copy the token **and** save the zip).
2. Unpack the zip into a permanent folder (e.g. `~/warsaw-beer-overlay/`).
3. `chrome://extensions` → Developer mode → Load unpacked → this folder.
4. Extension Options → paste the token → Save → Test connection → ✅.
5. Go to a supported shop — "already had it" badges + ratings will appear on their own.
6. Updating: the bot sends a new zip → unpack it over the same folder → **↻ reload**.
