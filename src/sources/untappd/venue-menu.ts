import * as cheerio from 'cheerio';
import { untappdRating } from './rating';

export interface VenueMenuItem {
  section: string;
  bid: number;
  name: string;
  brewery: string;
  style: string | null;
  abv: number | null;
  rating: number | null;
}

export interface VenueMenu {
  /** Untappd venue id of the page, from its canonical link; null when the page does not name one. */
  venueId: number | null;
  /** When Untappd says the menu was last updated (ISO), or null when the header is absent. */
  updatedAt: string | null;
  items: VenueMenuItem[];
}

const BID_RE = /^\/b\/[^/]+\/(\d+)/;
const UNTAPPD_ORIGINS = new Set(['https://untappd.com', 'https://www.untappd.com']);
const VENUE_PATH_RE = /^\/v\/[^/]+\/(\d+)(?:\/|$)/;

// The venue id of an Untappd venue URL, or null. Parsed with URL so the whole origin (scheme, host,
// port) is compared as normalised — case-insensitive host, default port only — while the path stays
// case-sensitive; a venue-looking fragment on another origin, behind credentials or in a query
// string is not a venue page.
function untappdVenueId(href: string): number | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (!UNTAPPD_ORIGINS.has(url.origin) || url.username !== '' || url.password !== '') return null;
  const m = url.pathname.match(VENUE_PATH_RE);
  return m ? parseInt(m[1], 10) : null;
}
const ABV_RE = /(\d+(?:\.\d+)?)\s*%\s*ABV/i;

const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();

// The menu block of an Untappd venue page (spec §4.1). Selectors from the 2026-09-29 probe:
// .menu-section > h4 (name + "(N Items)"), li.menu-item > h5 a[href^="/b/"], em (style),
// h6 span (ABV + brewery link), .caps[data-rating]. Items without a /b/ link (custom menu
// entries) carry no bid and are skipped. The Handlebars template lives inside <script>, which
// cheerio does not parse as DOM, so its placeholder links never match.
export function parseVenueMenu(html: string): VenueMenu {
  const $ = cheerio.load(html);
  const venueId = untappdVenueId($('link[rel="canonical"]').first().attr('href') ?? '');
  const updatedRaw = $('.menu-header .updated-time').first().attr('data-time') ?? '';
  const updatedMs = Date.parse(updatedRaw);
  const updatedAt = Number.isFinite(updatedMs) ? new Date(updatedMs).toISOString() : null;

  const items: VenueMenuItem[] = [];
  $('.menu-section').each((_, sectionEl) => {
    const header = $(sectionEl).find('.menu-section-header h4').first().clone();
    header.find('span').remove();
    const section = clean(header.text());
    if (!section) return;

    $(sectionEl).find('li.menu-item').each((__, itemEl) => {
      const item = $(itemEl);
      const beerLink = item.find('h5 a[href^="/b/"]').first();
      const m = (beerLink.attr('href') ?? '').match(BID_RE);
      if (!m) return;
      const name = clean(beerLink.text());
      const brewery = clean(item.find('h6 span a').first().text());
      if (!name || !brewery) return;
      const style = clean(item.find('h5 em').first().text()) || null;
      const abvMatch = clean(item.find('h6 span').first().text()).match(ABV_RE);
      items.push({
        section,
        bid: parseInt(m[1], 10),
        name,
        brewery,
        style,
        abv: abvMatch ? parseFloat(abvMatch[1]) : null,
        rating: untappdRating(item.find('.caps[data-rating]').first().attr('data-rating')),
      });
    });
  });
  return { venueId, updatedAt, items };
}
