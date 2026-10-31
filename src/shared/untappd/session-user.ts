import * as cheerio from 'cheerio';

const PROFILE_HREF_RE = /^\/user\/([^/?#]+)\/?$/;

// #924: whose untappd.com session this is, read from the page itself. A signed-in page links
// "My Profile" (`a[data-href=":user/profile"]`) to /user/<name> in the desktop and mobile menus;
// a signed-out page has no such link (live check 2026-10-31). Every link must name the same user,
// otherwise the answer is unknown. Lowercased, like the username in the extension's cache binding.
export function sessionUsername(html: string): string | null {
  const $ = cheerio.load(html);
  const names = new Set<string>();
  let malformed = false;
  $('a[data-href=":user/profile"]').each((_, a) => {
    const m = ($(a).attr('href') ?? '').match(PROFILE_HREF_RE);
    if (!m) {
      malformed = true;
      return false;
    }
    let name = m[1];
    try {
      name = decodeURIComponent(name);
    } catch {
      // A malformed escape keeps the raw segment, as authorFrom in checkin-feed.ts does.
    }
    names.add(name.toLowerCase());
  });
  if (malformed || names.size !== 1) return null;
  return [...names][0];
}
