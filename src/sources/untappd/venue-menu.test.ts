import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseVenueMenu } from './venue-menu';

const html = readFileSync(join(__dirname, '__fixtures__/venue-menu.html'), 'utf8');

describe('parseVenueMenu', () => {
  const menu = parseVenueMenu(html);

  it('reads every beer with a bid, in page order, across sections', () => {
    expect(menu.items).toEqual([
      { section: 'PINTA', bid: 6852012, name: 'Beskidy', brewery: 'Verdant Brewing Co', style: 'IPA - New England / Hazy', abv: 6.5, rating: 4.1 },
      { section: 'PINTA', bid: 6726011, name: 'See You On the Flipside - Hāpi Sessions Vol. 21: Pinta', brewery: 'Garage Project', style: 'IPA - American', abv: 6.1, rating: 4.07 },
      { section: 'PINTA', bid: 6491580, name: 'Risfactor Vanilla & Cinnamon', brewery: 'PINTA', style: 'Stout - Imperial / Double', abv: 10, rating: 4.03 },
      { section: 'Browar Test', bid: 7000001, name: 'New Beer', brewery: 'Browar Test', style: 'Sour - Fruited', abv: 5, rating: null },
    ]);
  });

  it('reads the menu update time as ISO', () => {
    expect(menu.updatedAt).toBe('2026-09-29T12:15:39.465Z');
  });

  it('returns an empty menu with no timestamp for a page without a menu', () => {
    expect(parseVenueMenu('<html><body><p>closed</p></body></html>')).toEqual({ updatedAt: null, items: [] });
  });
});
