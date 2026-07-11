import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
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

// CLI: npx tsx scripts/render-docs.ts
// Renders both extension install guides (docs/extension-install-*.md) to
// static self-contained HTML pages under site/ for GitHub Pages hosting.
function main(): void {
  const root = join(__dirname, '..');
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

// Run only when invoked directly, not when imported by the test.
if (require.main === module) {
  main();
}
