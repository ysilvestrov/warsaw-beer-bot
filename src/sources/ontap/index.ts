import * as cheerio from 'cheerio';

export interface IndexPub {
  slug: string;
  name: string;
  taps: number | null;
}

export function parseWarsawIndex(html: string): IndexPub[] {
  const $ = cheerio.load(html);
  const pubs = new Map<string, IndexPub>();

  $('div[onclick*="location.assign"][onclick*=".ontap.pl"]').each((_, el) => {
    const onclick = $(el).attr('onclick') ?? '';
    const m = onclick.match(/https?:\/\/([a-z0-9-]+)\.ontap\.pl/i);
    if (!m) return;
    const slug = m[1].toLowerCase();
    if (pubs.has(slug)) return;

    const body = $(el).find('.panel-body').first().clone();
    body.find('*').remove();
    const combined = body.text().trim().replace(/\s+/g, ' ');

    const tapsMatch = combined.match(/^(.+?)\s+(\d+)\s*taps?\b/i);
    const name = (tapsMatch ? tapsMatch[1] : combined).trim();
    const taps = tapsMatch ? parseInt(tapsMatch[2], 10) : null;

    if (!name) return;
    pubs.set(slug, { slug, name, taps });
  });

  return Array.from(pubs.values());
}
