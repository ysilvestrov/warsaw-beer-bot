// Untappd beer links for /fest take (spec 2026-10-15-fest-queue-reality-design.md §PR 1): the app's
// «Share» gives a short untp.beer link, which answers one 302 straight to untappd.com/b/<slug>/<bid>
// (probe 2026-10-15). The bid is read from that Location: the Untappd page itself answers 403 to the
// server, so it is never opened, and only untp.beer over https is ever fetched.

export type BeerLink = { bid: number } | { short: string } | null;

const FULL_RE = /^https:\/\/(?:www\.)?untappd\.com\/b\/[^/?#\s]+\/(\d{1,12})(?:[/?#]\S*)?$/;
// Codes seen are 5 characters; 16 keeps a short link whole in the team picker's 64-byte callback.
const SHORT_RE = /^https:\/\/untp\.beer\/[A-Za-z0-9]{1,16}$/;

/** A full /b/<slug>/<bid> link or a short untp.beer one; anything else (a check-in, a venue) is null. */
export function beerLinkOf(text: string): BeerLink {
  const t = text.trim();
  const full = FULL_RE.exec(t);
  if (full) {
    const bid = Number(full[1]);
    return bid > 0 ? { bid } : null;
  }
  return SHORT_RE.test(t) ? { short: t } : null;
}

/** One GET without following the redirect: the bid from a 3xx Location to a beer page, else null. */
export async function resolveShortLink(url: string, fetchFn: typeof fetch, timeoutMs = 5000): Promise<number | null> {
  try {
    const res = await fetchFn(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    if (res.status < 300 || res.status > 399) return null;
    const link = beerLinkOf(res.headers.get('location') ?? '');
    return link !== null && 'bid' in link ? link.bid : null;
  } catch {
    return null;
  }
}
