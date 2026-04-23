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
    const beer_ref = subtitle ? `${h4Text} — ${subtitle}` : h4Text;

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
      style: null,
      u_rating,
    });
  });

  return { pub: { name, address, lat, lon }, taps };
}
