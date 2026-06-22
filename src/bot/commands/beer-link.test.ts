import { describe, it, expect } from 'vitest';
import { beerNameHtml } from './beer-link';

describe('beerNameHtml', () => {
  it('wraps a matched beer in an Untappd anchor', () => {
    expect(beerNameHtml('JBW Brewery Wocky Talky', 6172039)).toBe(
      '<a href="https://untappd.com/beer/6172039"><b>JBW Brewery Wocky Talky</b></a>',
    );
  });

  it('renders an orphan (null id) as plain bold with no anchor', () => {
    expect(beerNameHtml('Some Orphan Beer', null)).toBe('<b>Some Orphan Beer</b>');
  });

  it('HTML-escapes the display name', () => {
    expect(beerNameHtml('Hop < & > IPA', 42)).toBe(
      '<a href="https://untappd.com/beer/42"><b>Hop &lt; &amp; &gt; IPA</b></a>',
    );
    expect(beerNameHtml('Hop < IPA', null)).toBe('<b>Hop &lt; IPA</b>');
  });
});
