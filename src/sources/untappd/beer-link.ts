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

/**
 * One GET without following the redirect: the bid from a 3xx Location to a beer page. `not_beer` only
 * when untp.beer says so — a redirect elsewhere, or 404/410 for a code it does not know. Anything else
 * (no answer, 429, 5xx, a page instead of a redirect) is `failed`: the link may be fine, so the person
 * is told to try again rather than that it is wrong.
 */
export async function resolveShortLink(url: string, fetchFn: typeof fetch, timeoutMs = 5000): Promise<number | 'not_beer' | 'failed'> {
  let res: Response;
  try {
    res = await fetchFn(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return 'failed';
  }
  // Only the status and a header are read: the body is let go so the connection is not held.
  await res.body?.cancel().catch(() => {});
  if (res.status === 404 || res.status === 410) return 'not_beer';
  if (res.status < 300 || res.status > 399) return 'failed';
  const link = beerLinkOf(res.headers.get('location') ?? '');
  return link !== null && 'bid' in link ? link.bid : 'not_beer';
}
