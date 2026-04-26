import * as cheerio from 'cheerio';

export interface ParsedPub {
  name: string;
  address: string | null;
  lat: number | null;
  lon: number | null;
}

export interface ParsedTap {
  tap_number: number | null;
  beer_ref: string;
  brewery_ref: string | null;
  abv: number | null;
  ibu: number | null;
  style: string | null;
  u_rating: number | null;
}

export interface ParsedPubPage {
  pub: ParsedPub;
  taps: ParsedTap[];
}

// Strip ABV/strength suffix and brewery prefix from h4 text.
// h4Text typically looks like "Brewery Name BeerName 24°·8,5%" — we want
// just "BeerName" so the matcher sees a canonical key.
export function extractBeerName(h4Text: string, brewery_ref: string | null): string {
  let s = h4Text;
  // Truncate at the first ABV/strength pattern: "16°", "8.5%", "24°·5%".
  const m = s.match(/^(.*?)\s+\d+(?:[.,]\d+)?\s*[°%]/);
  if (m) s = m[1];
  // Drop a leading brewery prefix when present.
  if (brewery_ref) {
    const brl = brewery_ref.toLowerCase();
    if (s.toLowerCase().startsWith(brl + ' ')) {
      s = s.slice(brl.length + 1);
    } else if (s.toLowerCase() === brl) {
      s = '';
    }
  }
  return s.trim();
}

export function parsePubPage(html: string): ParsedPubPage {
  const $ = cheerio.load(html);

  const rawTitle = $('meta[property="og:title"]').attr('content') ?? $('title').text();
  const name = rawTitle.split('/')[0].trim();

  let address: string | null = null;
  const marker = $('i.fa-map-marker').first();
  if (marker.length) {
    const next = marker[0].nextSibling;
    if (next && next.type === 'text') {
      const t = (next.data ?? '').trim().replace(/\s+/g, ' ');
      if (t) address = t;
    }
  }

  let lat: number | null = null;
  let lon: number | null = null;
  $('a[href*="maps.google"]').each((_, el) => {
    if (lat !== null) return;
    const href = $(el).attr('href') ?? '';
    const m = href.match(/([\-]?\d+\.\d+)[, ]+([\-]?\d+\.\d+)/);
    if (m) { lat = parseFloat(m[1]); lon = parseFloat(m[2]); }
  });

  const taps: ParsedTap[] = [];
  $('div.panel.panel-default[onclick*="beer?mode=view"]').each((_, el) => {
    const row = $(el);

    const numTxt = row.find('h5 .label').first().text().trim();
    const tap_number = /^\d+$/.test(numTxt) ? parseInt(numTxt, 10) : null;

    const brewery_ref = row.find('.brewery').first().text()
      .replace(/ /g, ' ').replace(/\s+/g, ' ').trim() || null;

    const h4Text = row.find('h4').first().text()
      .replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
    if (!h4Text) return;

    const abvMatch = h4Text.match(/(\d+(?:[.,]\d+)?)\s*%/);
    const abv = abvMatch ? parseFloat(abvMatch[1].replace(',', '.')) : null;

    const subtitle = row.find('span.cml_shadow > b').first().text()
      .replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
    const beer_ref = extractBeerName(h4Text, brewery_ref) || h4Text;
    const style = subtitle || null;

    let ibu: number | null = null;
    row.find('kbd').each((_, k) => {
      if (ibu !== null) return;
      const txt = $(k).text();
      const m = txt.match(/(\d+(?:\.\d+)?)\s*IBU/i);
      if (m) ibu = parseFloat(m[1]);
    });

    const ratingTxt = row.find('kbd[title="untappd"]').first().text();
    const ratingMatch = ratingTxt.match(/u:\s*(\d+(?:\.\d+)?)/i);
    const u_rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;

    taps.push({
      tap_number,
      beer_ref,
      brewery_ref,
      abv,
      ibu,
      style,
      u_rating,
    });
  });

  return { pub: { name, address, lat, lon }, taps };
}
