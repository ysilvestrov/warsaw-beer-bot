# English Extension Docs, Pages Hosting & README Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an English install guide, render both guides as GitHub Pages HTML from a single markdown source, link the guide from the extension (options + no-token popup), and add a project README — closing #162.

**Architecture:** Markdown stays the single source of truth. A repo script (`scripts/render-docs.ts`, using `marked`) wraps each guide's rendered HTML in a shared self-contained template with an EN⇄UK switch; `pages.yml` runs it in CI before uploading `site/`. The extension exposes a single `SETUP_GUIDE_URL` constant surfaced in the options page and the popup's no-token state.

**Tech Stack:** Node/TypeScript, tsx, marked (new root devDependency), Vitest, GitHub Actions Pages, MV3 browser extension (jsdom tests).

---

## File Structure

- `scripts/render-docs.ts` (create) — pure `renderPage()` + `main()` writing HTML to `site/`.
- `scripts/render-docs.test.ts` (create) — unit tests for `renderPage()`.
- `package.json` (modify, root) — add `marked` devDep + `render-docs` script.
- `docs/extension-install-en.md` (create) — English translation of the UK guide.
- `.github/workflows/pages.yml` (modify) — Node setup + `npm ci` + render step + `paths`.
- `site/index.html` (modify) — link `install/` (EN) and `install-uk/` (UK).
- `.gitignore` (modify) — ignore generated `site/install/` and `site/install-uk/`.
- `extension/src/shared/config.ts` (modify) — add `SETUP_GUIDE_URL`.
- `extension/src/options/options.html` + `options.ts` (modify) — guide link.
- `extension/src/popup/popup.html` + `popup.ts` (modify) — no-token guide link + `guideLinkVisible()`.
- `extension/src/popup/popup.test.ts` (modify) — test `guideLinkVisible()` + URL.
- `extension/src/shared/config.test.ts` (create) — test `SETUP_GUIDE_URL`.
- `README.md` (create) — English project overview.
- `docs/extension-install-en.md` + `docs/extension-install-uk.md` (modify, Task 8) — mention the in-extension guide link.
- `spec.md` (review, Task 8).

Public URLs after deploy: EN `https://ysilvestrov.github.io/warsaw-beer-bot/install/`, UK `https://ysilvestrov.github.io/warsaw-beer-bot/install-uk/`.

---

## Task 1: Markdown → HTML render script

**Files:**
- Create: `scripts/render-docs.ts`
- Test: `scripts/render-docs.test.ts`
- Modify: `package.json` (root)

- [ ] **Step 1: Add `marked` and the script entry**

Run: `npm install -D marked@^14`

Then add to root `package.json` `scripts`:

```json
"render-docs": "tsx scripts/render-docs.ts"
```

- [ ] **Step 2: Write the failing test**

Create `scripts/render-docs.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { renderPage } from './render-docs';

describe('renderPage', () => {
  const html = renderPage({
    markdown: '# Title\n\nHello **world**.',
    lang: 'en',
    altLang: 'uk',
    altHref: '../install-uk/',
    homeHref: '../',
  });

  it('renders the markdown body to HTML', () => {
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>world</strong>');
  });

  it('sets the document language', () => {
    expect(html).toContain('<html lang="en">');
  });

  it('includes the language switch to the other guide', () => {
    expect(html).toContain('href="../install-uk/"');
    expect(html.toLowerCase()).toContain('українською');
  });

  it('links back to the landing page', () => {
    expect(html).toContain('href="../"');
  });

  it('is self-contained (no external asset references)', () => {
    expect(html).not.toMatch(/<link[^>]+href="http/);
    expect(html).not.toMatch(/<script[^>]+src=/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- scripts/render-docs.test.ts`
Expected: FAIL — cannot import `./render-docs` / `renderPage` not defined.

- [ ] **Step 4: Implement `scripts/render-docs.ts`**

```ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

export interface RenderOptions {
  markdown: string;
  lang: 'en' | 'uk';
  altLang: 'en' | 'uk';
  altHref: string;
  homeHref: string;
}

const ALT_LABEL: Record<'en' | 'uk', string> = {
  en: 'Read in English',
  uk: 'Читати українською',
};

const HOME_LABEL: Record<'en' | 'uk', string> = { en: '← Home', uk: '← На головну' };

const STYLE = `
  :root { color-scheme: light dark; }
  body { max-width: 46rem; margin: 2rem auto; padding: 0 1.1rem;
    font: 16px/1.6 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    color: #1a1a1a; background: #fff; }
  nav { display: flex; gap: 1rem; margin-bottom: 1.5rem; font-size: .95rem; }
  a { color: #1a5fb4; }
  h1 { font-size: 1.7rem; } h2 { margin-top: 2rem; }
  code { background: rgba(127,127,127,.15); padding: .1em .3em; border-radius: 3px; }
  pre { background: rgba(127,127,127,.12); padding: .8rem; border-radius: 6px; overflow-x: auto; }
  img { max-width: 100%; }
  @media (prefers-color-scheme: dark) {
    body { color: #e6e6e6; background: #16181c; }
    a { color: #78aeed; }
  }`;

export function renderPage(opts: RenderOptions): string {
  const body = marked.parse(opts.markdown, { async: false }) as string;
  return `<!doctype html>
<html lang="${opts.lang}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Warsaw Beer Overlay — Setup</title>
    <style>${STYLE}</style>
  </head>
  <body>
    <nav>
      <a href="${opts.homeHref}">${HOME_LABEL[opts.lang]}</a>
      <a href="${opts.altHref}">${ALT_LABEL[opts.altLang]}</a>
    </nav>
    ${body}
  </body>
</html>
`;
}

function main(): void {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const targets = [
    { src: 'docs/extension-install-en.md', out: 'site/install/index.html',
      lang: 'en' as const, altLang: 'uk' as const, altHref: '../install-uk/' },
    { src: 'docs/extension-install-uk.md', out: 'site/install-uk/index.html',
      lang: 'uk' as const, altLang: 'en' as const, altHref: '../install/' },
  ];
  for (const t of targets) {
    const markdown = readFileSync(join(root, t.src), 'utf8');
    const html = renderPage({ markdown, lang: t.lang, altLang: t.altLang,
      altHref: t.altHref, homeHref: '../' });
    const outPath = join(root, t.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, html);
    console.log(`rendered ${t.src} -> ${t.out}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- scripts/render-docs.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add scripts/render-docs.ts scripts/render-docs.test.ts package.json package-lock.json
git commit -m "feat(docs): markdown->HTML render script for Pages guides (#162)"
```

---

## Task 2: English translation of the install guide

**Files:**
- Create: `docs/extension-install-en.md`

- [ ] **Step 1: Translate the UK guide section-for-section**

Source of truth: `docs/extension-install-uk.md` (244 lines). Produce `docs/extension-install-en.md` as a faithful English translation that preserves the **same heading structure and order** so both files can be updated together. Heading map (translate each; keep the same nesting level):

| UK heading | EN heading |
|---|---|
| `# Браузерне розширення «Warsaw Beer Overlay» — встановлення та налаштування` | `# Browser extension "Warsaw Beer Overlay" — install & setup` |
| `### Що видно без токена` | `### What you see without a token` |
| `## Передумови` | `## Prerequisites` |
| `## Частина 1. Реєстрація в боті та завантаження списку пив` | `## Part 1. Register in the bot and import your beer list` |
| `### 1.1. Запустити бота й обрати мову` | `### 1.1. Start the bot and pick a language` |
| `### 1.2. Прив'язати акаунт Untappd` | `### 1.2. Link your Untappd account` |
| `### 1.3. Завантажити історію пив (імпорт) — це і є «список пив»` | `### 1.3. Import your beer history — this is your "beer list"` |
| `### 1.4. Отримати токен доступу для розширення` | `### 1.4. Get an access token for the extension` |
| `## Частина 2. Встановлення розширення` | `## Part 2. Install the extension` |
| `### 2.1. Отримати zip` | `### 2.1. Get the zip` |
| `### 2.2. Завантажити в браузер (на прикладі Chrome)` | `### 2.2. Load it into the browser (Chrome example)` |
| `### 2.3. Оновлення` | `### 2.3. Updating` |
| `## Частина 3. Налаштування розширення` | `## Part 3. Configure the extension` |
| `## Частина 4. Використання` | `## Part 4. Using it` |
| `### Кнопка розширення на панелі (popup)` | `### The toolbar button (popup)` |
| `### «Sync my check-ins» — синхронізація чекінів без Supporter` | `### "Sync my check-ins" — sync check-ins without Supporter` |
| `## Усунення несправностей` | `## Troubleshooting` |
| `## Коротко (швидкий старт)` | `## In short (quick start)` |

Keep the badge glyphs (✅/⭐/❓/⚪), shop names, bot command names (`/link`, `/extension`), code spans, and any image references identical. Translate prose faithfully; do not add or drop sections. Use the project's beer wording conventions.

- [ ] **Step 2: Sanity-render locally**

Run: `npm run render-docs`
Expected: `rendered docs/extension-install-en.md -> site/install/index.html` and the UK line; open `site/install/index.html` to confirm headings render.

- [ ] **Step 3: Commit**

```bash
git add docs/extension-install-en.md
git commit -m "docs: English translation of the extension install guide (#162)"
```

---

## Task 3: Wire Pages workflow, landing links, gitignore

**Files:**
- Modify: `.github/workflows/pages.yml`
- Modify: `site/index.html`
- Modify: `.gitignore`

- [ ] **Step 1: Ignore generated guide dirs**

Append to `.gitignore`:

```
# Generated on GitHub Pages from docs/extension-install-*.md (see scripts/render-docs.ts)
site/install/
site/install-uk/
```

- [ ] **Step 2: Add the render step to `pages.yml`**

In `.github/workflows/pages.yml`, extend the `on.push.paths` list and insert Node setup + render before the artifact upload. Replace the `steps:` block of the `deploy` job with:

```yaml
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run render-docs
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: site
      - id: deployment
        uses: actions/deploy-pages@v4
```

And change the `paths` trigger to:

```yaml
    paths: ['site/**', 'docs/extension-install-*.md', 'scripts/render-docs.ts', '.github/workflows/pages.yml']
```

- [ ] **Step 3: Update landing page links**

In `site/index.html`, replace the current single install `<li>` (the raw-blob "(Ukrainian)" link) with two entries pointing at the rendered pages:

```html
      <li>📥 <a href="install/">Install &amp; setup guide (English)</a></li>
      <li>📥 <a href="install-uk/">Інструкція встановлення (українською)</a></li>
```

- [ ] **Step 4: Verify workflow + render locally**

Run: `npm run render-docs && test -f site/install/index.html && test -f site/install-uk/index.html && echo OK`
Expected: `OK`.
Run: `git status --porcelain site/` — Expected: no `site/install*` entries appear (they're ignored); only `site/index.html` shows as modified.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/pages.yml site/index.html .gitignore
git commit -m "ci(pages): render install guides to HTML + link from landing (#162)"
```

---

## Task 4: Extension guide-URL constant

**Files:**
- Modify: `extension/src/shared/config.ts`
- Test: `extension/src/shared/config.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `extension/src/shared/config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { SETUP_GUIDE_URL } from './config';

describe('SETUP_GUIDE_URL', () => {
  it('points at the hosted English setup guide', () => {
    expect(SETUP_GUIDE_URL).toBe('https://ysilvestrov.github.io/warsaw-beer-bot/install/');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npm test -- src/shared/config.test.ts`
Expected: FAIL — `SETUP_GUIDE_URL` not exported.

- [ ] **Step 3: Add the constant**

In `extension/src/shared/config.ts`, below `DEFAULT_BASE_URL`:

```ts
/** Hosted English install & setup guide, linked from the options page and no-token popup. */
export const SETUP_GUIDE_URL = 'https://ysilvestrov.github.io/warsaw-beer-bot/install/';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && npm test -- src/shared/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/src/shared/config.ts extension/src/shared/config.test.ts
git commit -m "feat(extension): add SETUP_GUIDE_URL constant (#162)"
```

---

## Task 5: Guide link on the options page

**Files:**
- Modify: `extension/src/options/options.html`
- Modify: `extension/src/options/options.ts`

- [ ] **Step 1: Add the link element to the options HTML**

In `extension/src/options/options.html`, add right after the `<h1>` (line 10) so it sits above the token field:

```html
      <p class="guide">New here? <a id="guideLink" target="_blank" rel="noopener">Read the setup guide →</a></p>
```

- [ ] **Step 2: Set its href from the constant**

In `extension/src/options/options.ts`, import the constant and set the href inside `initOptionsPage()`. Change the import on line 1:

```ts
import { getSettings, setSettings, DEFAULT_BASE_URL, SETUP_GUIDE_URL } from '../shared/config';
```

Then near the top of `initOptionsPage()` (after the early-return guard on line 44) add:

```ts
  const guideLink = el<HTMLAnchorElement>('guideLink');
  if (guideLink) guideLink.href = SETUP_GUIDE_URL;
```

- [ ] **Step 3: Typecheck + build sanity**

Run: `cd extension && npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add extension/src/options/options.html extension/src/options/options.ts
git commit -m "feat(extension): link the setup guide from the options page (#162)"
```

---

## Task 6: Guide link in the popup no-token state

**Files:**
- Modify: `extension/src/popup/popup.html`
- Modify: `extension/src/popup/popup.ts`
- Test: `extension/src/popup/popup.test.ts`

- [ ] **Step 1: Write the failing test**

In `extension/src/popup/popup.test.ts`, extend the import and add a describe block:

```ts
import { canRefresh, formatSyncStatus, authNoteText, guideLinkVisible } from './popup';
import { SETUP_GUIDE_URL } from '../shared/config';

describe('guideLinkVisible', () => {
  it('shows the guide link only when there is no token', () => {
    expect(guideLinkVisible(false)).toBe(true);
    expect(guideLinkVisible(true)).toBe(false);
  });
  it('links to the hosted setup guide', () => {
    expect(SETUP_GUIDE_URL).toContain('/install/');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npm test -- src/popup/popup.test.ts`
Expected: FAIL — `guideLinkVisible` not exported.

- [ ] **Step 3: Add the helper, HTML element, and wiring**

In `extension/src/popup/popup.ts`, add the import and helper near `authNoteText` (after line 47):

```ts
import { getSettings, SETUP_GUIDE_URL } from '../shared/config';
```
(replace the existing `import { getSettings } from '../shared/config';` on line 3)

```ts
/** The setup-guide link is shown in the same no-token state as the auth note. */
export function guideLinkVisible(hasToken: boolean): boolean {
  return !hasToken;
}
```

In `extension/src/popup/popup.html`, add after the `getToken` button (line 21):

```html
      <a id="guideLink" target="_blank" rel="noopener" style="display:none">Read the setup guide →</a>
```

In `initPopup()`, extend the no-token branch (the `if (note) { ... } else { ... }` around lines 68–78) to also toggle the guide link. Replace that block with:

```ts
  const guideLink = el<HTMLAnchorElement>('guideLink');
  if (authNote && getTokenBtn && guideLink) {
    if (note) {
      authNote.textContent = note;
      authNote.style.display = '';
      getTokenBtn.style.display = '';
      getTokenBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
      guideLink.href = SETUP_GUIDE_URL;
      guideLink.style.display = guideLinkVisible(Boolean(token)) ? '' : 'none';
    } else {
      authNote.style.display = 'none';
      getTokenBtn.style.display = 'none';
      guideLink.style.display = 'none';
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd extension && npm test -- src/popup/popup.test.ts`
Expected: PASS. Then `cd extension && npm run typecheck` — no errors.

- [ ] **Step 5: Commit**

```bash
git add extension/src/popup/popup.html extension/src/popup/popup.ts extension/src/popup/popup.test.ts
git commit -m "feat(extension): show setup-guide link in the no-token popup (#162)"
```

---

## Task 7: Project README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write `README.md`**

Create `README.md` at the repo root:

```markdown
# Warsaw Beer Overlay

A personal, non-commercial project that helps craft-beer shoppers in Warsaw see which
beers they've already had. It has three parts:

- **Telegram bot** — links your Untappd account, imports your check-in history, and
  serves beer matches over an API.
- **Beer API** — matches shop beers against your Untappd history and global ratings.
- **Browser extension** — badges every beer on supported shop pages:
  ⭐ community rating · ✅ you've had it (with your rating) · ❓ probable match ·
  ⚪ known beer, not yet on Untappd.

Works on BeerRepublic, OneMoreBeer, BeerFreak, Bierloods22, WineTime, Hoptimaal,
Flasker, Piwne Mosty, and Funkyshop.

## Install & use

- Setup guide (English): https://ysilvestrov.github.io/warsaw-beer-bot/install/
- Інструкція встановлення (українською): https://ysilvestrov.github.io/warsaw-beer-bot/install-uk/
- [Privacy policy](https://ysilvestrov.github.io/warsaw-beer-bot/privacy/)

## Development

Stack: Node.js, TypeScript, Telegraf (Telegram), SQLite, Vitest.

- API keys and config are read from a `.env` file.
- Install deps: `npm install`
- Run tests: `npm test` (extension tests: `cd extension && npm test`)
- Run the bot locally: `npm run dev`

See [`spec.md`](../../../../spec.md) for the canonical behavior specification.

---

Personal, non-commercial project by Yuriy Silvestrov.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add project README (#162)"
```

---

## Task 8: Document the in-extension link + spec review

**Files:**
- Modify: `docs/extension-install-en.md`
- Modify: `docs/extension-install-uk.md`
- Review: `spec.md`

- [ ] **Step 1: Mention the in-extension guide link in both guides**

In the popup section of each guide (`### The toolbar button (popup)` / `### Кнопка розширення на панелі (popup)`) and the options/config section, add a sentence noting that the extension itself links back to this guide: the **options page** shows a "Read the setup guide" link, and the **popup shows it when no token is set**. Keep both language files parallel.

- [ ] **Step 2: Review `spec.md` for a matching update**

Run: `grep -niE "popup|options|extension" spec.md | head -30`
If a section documents the extension's popup/options UI surface, add a bullet noting the setup-guide link (options always; popup in the no-token state). If no such UI-surface section exists, note in the commit body that spec.md needs no change. Do not invent a new section.

- [ ] **Step 3: Commit**

```bash
git add docs/extension-install-en.md docs/extension-install-uk.md spec.md
git commit -m "docs: note the in-extension setup-guide link in guides + spec (#162)"
```

---

## Task 9: Full verification

- [ ] **Step 1: Root tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: all green (includes `scripts/render-docs.test.ts`).

- [ ] **Step 2: Extension tests + typecheck + build**

Run: `cd extension && npm test && npm run typecheck && npm run build`
Expected: all green; `dist/` builds (popup + options HTML include the guide link).

- [ ] **Step 3: Render + audit**

Run: `npm run render-docs && npm audit`
Expected: both guide HTML files produced; audit unaffected (0 vulnerabilities).

- [ ] **Step 4: Push branch and open PR**

Open a PR referencing #162. This is a user-facing extension change → the AI-review/PR loop and the extension-docs mandate apply (both guides updated in Task 8).

---

## Self-Review Notes

- **Spec coverage:** EN translation → Task 2; Pages rendering (build step, single source, EN⇄UK switch) → Tasks 1+3; landing links → Task 3; extension links (options + no-token popup) → Tasks 4–6; README → Task 7; docs/spec mandate → Task 8; testing → Tasks 1,4,6,9. All spec sections covered.
- **Type consistency:** `SETUP_GUIDE_URL` (config) used identically in options.ts, popup.ts, and tests. `guideLinkVisible(hasToken)` mirrors `authNoteText(hasToken)`. Element id `guideLink` consistent across options.html, popup.html, and both `.ts` files. `renderPage(RenderOptions)` signature matches its test.
- **Generated-file safety:** `site/install*/` are git-ignored (Task 3 Step 1) and produced in CI before upload — never committed.
