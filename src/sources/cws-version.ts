// The version users actually have, read from the endpoint Chrome itself queries when
// it decides whether to update an extension (#379). This is ground truth rather than a
// proxy: if it reports 0.16.0, browsers update to 0.16.0. It needs no credentials, so
// the CWS API keys stay on the release host and never reach production.
//
// `npm run release:store` is NOT this signal — it submits for review, and review can
// take days.

// Chrome Web Store item id. Single source of truth: the bot's store link, the release
// script's default item, and this poller all read it from here.
export const CWS_ITEM_ID = 'fdelmnhijeiojadcaihfdpecfcldbndg';

const UPDATE_ENDPOINT = 'https://clients2.google.com/service/update2/crx';

export function updateCheckUrl(itemId: string): string {
  const x = encodeURIComponent(`id=${itemId}&uc`);
  return `${UPDATE_ENDPOINT}?response=updatecheck&prodversion=140.0&acceptformat=crx3&x=${x}`;
}

/**
 * The published version, or null when the response does not carry one.
 *
 * Keys on the `<updatecheck>` element's own `status`, not the enclosing `<app>`'s: an
 * unknown item answers with `<app status="error-unknownApplication"/>` and no
 * `<updatecheck>` at all, which is what keeps "could not read" distinguishable from
 * "unchanged". Attributes are read individually rather than in one ordered pattern, so
 * a future reordering by Google cannot silently turn a real version into null.
 */
export function parsePublishedVersion(xml: string): string | null {
  const tag = /<updatecheck\b([^>]*)>/.exec(xml);
  if (!tag) return null;
  const attrs = tag[1];
  if (/\bstatus="([^"]*)"/.exec(attrs)?.[1] !== 'ok') return null;
  const version = /\bversion="([^"]*)"/.exec(attrs)?.[1];
  // Dotted numerics only — anything else is a shape we do not understand, and guessing
  // would feed compareVersions a NaN.
  return version && /^\d+(\.\d+)*$/.test(version) ? version : null;
}

/** -1 / 0 / 1, comparing dotted segments numerically; the shorter side is zero-padded. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export interface CwsVersionDeps {
  fetchImpl?: typeof fetch;
  itemId?: string;
  timeoutMs?: number;
}

/**
 * Null on a non-2xx or an unreadable body; throws on a network/timeout failure so the
 * caller logs it. Plain `fetch` rather than `createHttp`: that helper carries an
 * Untappd cookie, a proxy rotator and a block detector, none of which apply to 793
 * bytes of public XML.
 */
export async function fetchPublishedVersion(deps: CwsVersionDeps = {}): Promise<string | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const res = await fetchImpl(updateCheckUrl(deps.itemId ?? CWS_ITEM_ID), {
    signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
  });
  if (!res.ok) return null;
  return parsePublishedVersion(await res.text());
}
