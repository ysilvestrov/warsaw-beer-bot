import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { renderPage, renderDocs } from './render-docs';

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

  it('defaults the document title to the setup guide title', () => {
    expect(html).toContain('<title>Warsaw Beer Overlay — Setup</title>');
  });
});

describe('renderPage — single-language page (e.g. changelog)', () => {
  const html = renderPage({
    markdown: '# Changelog\n\n## [0.12.0]\n\n- A change.',
    lang: 'en',
    title: 'Warsaw Beer Overlay — Changelog',
    homeHref: '../',
  });

  it('uses the provided title', () => {
    expect(html).toContain('<title>Warsaw Beer Overlay — Changelog</title>');
  });

  it('links back to the landing page', () => {
    expect(html).toContain('href="../"');
  });

  it('omits the alternate-language nav link when no alt language is given', () => {
    expect(html.toLowerCase()).not.toContain('українською');
    expect(html).not.toContain('Read in English');
    // Only the "← Home" link should be in the nav.
    const nav = html.slice(html.indexOf('<nav>'), html.indexOf('</nav>'));
    expect(nav.match(/<a /g) ?? []).toHaveLength(1);
  });

  it('renders the markdown body to HTML', () => {
    expect(html).toContain('<h1>Changelog</h1>');
  });
});

// Smoke test the real file-reading path against the actual repo sources, so a
// malformed changelog / install guide fails a PR rather than the Pages deploy.
describe('renderDocs (real repo files)', () => {
  const repoRoot = join(__dirname, '..');
  const rendered = renderDocs(repoRoot);

  it('renders all three targets without throwing', () => {
    expect(rendered.map((r) => r.out).sort()).toEqual([
      'site/changelog/index.html',
      'site/install-uk/index.html',
      'site/install/index.html',
    ]);
  });

  it('renders the real changelog with the changelog title and a version entry', () => {
    const changelog = rendered.find((r) => r.out === 'site/changelog/index.html');
    expect(changelog).toBeDefined();
    expect(changelog!.html).toContain('<title>Warsaw Beer Overlay — Changelog</title>');
    // The real CHANGELOG uses "## [x.y.z]" headings -> <h2>[x.y.z]</h2>.
    expect(changelog!.html).toMatch(/<h2[^>]*>\[\d+\.\d+\.\d+\]/);
    expect(changelog!.html).toContain('href="../"'); // ← Home
    expect(changelog!.html.toLowerCase()).not.toContain('українською');
  });
});
