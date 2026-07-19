import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { marked } from 'marked';

export interface RenderOptions {
  markdown: string;
  lang: 'en' | 'uk';
  homeHref: string;
  /** Document <title>. Defaults to the install-guide title. */
  title?: string;
  /** Alternate-language link. Rendered only when both are provided. */
  altLang?: 'en' | 'uk';
  altHref?: string;
}

const DEFAULT_TITLE = 'Warsaw Beer Overlay — Setup';

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
  const navLinks = [`<a href="${opts.homeHref}">${HOME_LABEL[opts.lang]}</a>`];
  if (opts.altLang && opts.altHref) {
    navLinks.push(`<a href="${opts.altHref}">${ALT_LABEL[opts.altLang]}</a>`);
  }
  return `<!doctype html>
<html lang="${opts.lang}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${opts.title ?? DEFAULT_TITLE}</title>
    <style>${STYLE}</style>
  </head>
  <body>
    <nav>
      ${navLinks.join('\n      ')}
    </nav>
    ${body}
  </body>
</html>
`;
}

const SETUP_TITLE = 'Warsaw Beer Overlay — Setup';

// The pages rendered to site/ for GitHub Pages, relative to the repo root.
const TARGETS: (Omit<RenderOptions, 'markdown'> & { src: string; out: string })[] = [
  { src: 'docs/extension-install-en.md', out: 'site/install/index.html',
    lang: 'en', title: SETUP_TITLE, altLang: 'uk', altHref: '../install-uk/', homeHref: '../' },
  { src: 'docs/extension-install-uk.md', out: 'site/install-uk/index.html',
    lang: 'uk', title: SETUP_TITLE, altLang: 'en', altHref: '../install/', homeHref: '../' },
  { src: 'extension/CHANGELOG.md', out: 'site/changelog/index.html',
    lang: 'en', title: 'Warsaw Beer Overlay — Changelog', homeHref: '../' },
];

// Reads each source under `root` and renders it to HTML. Pure w.r.t. the
// filesystem output (no writes) so it can be exercised in tests against the
// real repo files — a malformed source throws here rather than at deploy time.
export function renderDocs(root: string): { src: string; out: string; html: string }[] {
  return TARGETS.map((t) => {
    const markdown = readFileSync(join(root, t.src), 'utf8');
    return { src: t.src, out: t.out, html: renderPage({ ...t, markdown }) };
  });
}

// CLI: npx tsx scripts/render-docs.ts
// Renders the extension install guides (docs/extension-install-*.md) and the
// changelog (extension/CHANGELOG.md) to static self-contained HTML pages under
// site/ for GitHub Pages hosting.
function main(): void {
  const root = join(__dirname, '..');
  for (const { src, out, html } of renderDocs(root)) {
    const outPath = join(root, out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, html);
    console.log(`rendered ${src} -> ${out}`);
  }
}

// Run only when invoked directly, not when imported by the test.
if (require.main === module) {
  main();
}
