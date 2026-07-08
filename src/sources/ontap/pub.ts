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

export function isOntapEmptyTapRef(beerRef: string): boolean {
  return beerRef.trim().toUpperCase() === 'N/A';
}

function escapeRegExp(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compact(raw: string): string {
  return raw.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

function normalized(raw: string): string {
  return compact(raw).toLowerCase();
}

function breweryCore(raw: string): string {
  return compact(raw)
    .replace(/\s+(?:brewery|browar|brasserie|brouwerij|brauerei|pivovar|birrificio)$/iu, '')
    .trim();
}

function stripLeadingCider(raw: string): string {
  return compact(raw).replace(/^(?:cydr|cider)(?:\s+|$)/iu, '').trim();
}

function breweryPrefixes(breweryRef: string | null): string[] {
  const brewery = compact(breweryRef ?? '');
  return brewery ? [brewery] : [];
}

// Strip ABV/strength suffix and brewery prefix from h4 text.
// h4Text typically looks like "Brewery Name BeerName 24°·8,5%" — we want
// just "BeerName" so the matcher sees a canonical key.
export function extractBeerName(h4Text: string, brewery_ref: string | null): string {
  let s = compact(h4Text);
  // Remove trailing strength only. Some beer names contain degree marks
  // ("La 150° Bionda"), so truncating at the first ° corrupts the name.
  s = s
    .replace(/\s+(?:\d{1,2}(?:[.,]\d+)?\s*°\s*[·•]\s*)?\d+(?:[.,]\d+)?\s*%(?:\s*[—-].*)?$/u, '')
    .replace(/\s+\d{1,2}(?:[.,]\d+)?\s*°$/u, '')
    .trim();
  // Drop a leading brewery prefix when present.
  for (const prefix of breweryPrefixes(brewery_ref)) {
    const brl = prefix.toLowerCase();
    if (s.toLowerCase().startsWith(`${brl} `)) {
      s = s.slice(prefix.length + 1);
      break;
    } else if (s.toLowerCase() === brl) {
      s = '';
      break;
    }
  }
  return s.trim();
}

const POLLUTED_BREWERIES = new Set([
  // Exact parser-polluted production sentinels from #235. Keep this narrow:
  // returning null here means refreshOntap will skip catalog/enrich writes.
  'w brzesku brewery',
  'vaisiu sultys',
]);

export function normalizeOntapTapIdentity(
  breweryRef: string | null,
  beerRef: string,
): { brewery: string; name: string } | null {
  const brewery = compact(breweryRef ?? '');
  let name = compact(beerRef);
  if (!name) return null;

  const breweryNorm = normalized(brewery);
  if (POLLUTED_BREWERIES.has(breweryNorm)) return null;

  const core = breweryCore(brewery);
  if (core && normalized(name) === normalized(core)) return null;

  if (breweryNorm === 'cydr dzik' || breweryNorm === 'cydr dzik brewery') {
    if (normalized(name) === 'polski cydr') return { brewery: 'Cydrownia', name: 'Dzik' };
    const ciderName = stripLeadingCider(name);
    if (!ciderName) return { brewery, name };
    return { brewery: 'Cydrownia', name: `Dzik ${ciderName}` };
  }

  if (breweryNorm === 'cydr flirt tradycynis') {
    const ciderName = stripLeadingCider(name);
    return {
      brewery: 'Kauno Alus',
      name: ciderName ? `Tradycynis Cydr Flirt ${ciderName}` : 'Tradycynis Cydr Flirt',
    };
  }

  if (core) {
    const ciderPrefix = new RegExp(`^(?:cydr|cider)\\s+${escapeRegExp(core)}\\s*[-–—:]\\s*`, 'iu');
    const stripped = name.replace(ciderPrefix, '').trim();
    if (stripped) name = stripped;
  }

  return { brewery, name };
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

    // Label is usually a bare "12", but pump/cask taps read "12 Pompa".
    // Take the leading integer; non-numeric labels (e.g. "Pompa") stay null.
    const numTxt = row.find('h5 .label').first().text().trim();
    const numMatch = numTxt.match(/^\d+/);
    const tap_number = numMatch ? parseInt(numMatch[0], 10) : null;

    const brewery_ref = row.find('.brewery').first().text()
      .replace(/ /g, ' ').replace(/\s+/g, ' ').trim() || null;

    const h4Text = row.find('h4').first().text()
      .replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
    if (!h4Text) return;

    const abvMatch = h4Text.match(/(\d+(?:[.,]\d+)?)\s*%/);
    const abv = abvMatch ? parseFloat(abvMatch[1].replace(',', '.')) : null;

    const subtitle = row.find('span.cml_shadow > b').first().text()
      .replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
    const extractedBeerName = extractBeerName(h4Text, brewery_ref);
    const beer_ref = extractedBeerName || (brewery_ref ? '' : h4Text);
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
