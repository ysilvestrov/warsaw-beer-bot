import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { lookupBeer } from './untappd-lookup';
import { htmlSearch } from '../sources/untappd/search';

const dir = resolve(__dirname, '../../tests/fixtures/untappd-search');
const html = (slug: string) => readFileSync(resolve(dir, `${slug}.html`), 'utf8');

// brewery/name are the values produced AFTER the #117 adapter + query fixes.
const cases: Array<{ slug: string; brewery: string; name: string; bid: number | null }> = [
  { slug: 'kykao',        brewery: 'Kykao - Handcrafted', name: 'Sour Berliner Weisse - Raspberry Edition (2025)', bid: 6479503 },
  { slug: 'schneider',    brewery: 'Schneider',           name: 'TAP04 FESTWEISSE',          bid: 11827 },
  { slug: 'fast-talking', brewery: 'Root + Branch',       name: 'Fast Talking / North Park', bid: 6683161 },
  { slug: 'messorem',     brewery: 'Messorem',            name: 'Globe Coagulant / Finback', bid: 6538432 },
  { slug: 'primator',     brewery: 'Primator',            name: 'PRIMÁTOR FREE MOTHER IN LAW', bid: 5817947 },
  { slug: 'omnipollo',    brewery: 'Omnipollo collab/ Trillium Brewing Company', name: 'Kanelbullar', bid: 6423273 },
  { slug: 'staropolski',  brewery: 'Staropolski',         name: 'KULTOWE PILS',              bid: 1673808 }, // #120 fixed
  { slug: 'st-feuillien', brewery: '',                    name: 'St-Feuillien Blonde',       bid: 22540 },   // #149
  { slug: 'murphys',      brewery: "Murphy's Brewery",     name: "Murphy's Irish Stout",      bid: 5932 },    // #138B
  { slug: 'trzech',       brewery: 'TRZECH KUMPLI Brewery',  name: 'Porter Bałtycki Żytnio-Orkiszowy Trzech Kumpli', bid: 6568809 }, // #155 trailing
  { slug: 'track-clean',  brewery: 'TRACK BREWING CO.',      name: 'Track Brewing Company Taking Shape',            bid: 6645521 }, // #126 (cleaned-query page)
];

describe('#117 lookupBeer against real Untappd search pages', () => {
  for (const { slug, brewery, name, bid } of cases) {
    test(`${slug} → ${bid === null ? 'not_found (deferred #120)' : `bid ${bid}`}`, async () => {
      const out = await lookupBeer({ brewery, name, search: htmlSearch(html(slug)) });
      if (bid === null) {
        expect(out.kind).toBe('not_found');
      } else {
        expect(out.kind).toBe('matched');
        if (out.kind !== 'matched') return;
        expect(out.result.bid).toBe(bid);
      }
    });
  }
});
