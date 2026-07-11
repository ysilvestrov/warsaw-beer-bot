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
