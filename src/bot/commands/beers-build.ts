import type { DB } from '../../storage/db';
import type { Locale, Translator } from '../../i18n/types';
import { latestSnapshot, tapsForSnapshotWithBeer } from '../../storage/snapshots';
import { listPubs } from '../../storage/pubs';
import { filterPubsByQuery } from './newbeers-build';
import { escapeHtml } from './newbeers-format';

export interface BeersDeps {
  db: DB;
  locale: Locale;
  t: Translator;
  pubQuery?: string;
}

export type BeersResult =
  | { kind: 'ok'; html: string }
  | { kind: 'no_arg' }
  | { kind: 'pub_not_found'; query: string }
  | { kind: 'ambiguous'; pubs: { name: string; address: string | null }[] }
  | { kind: 'empty'; pub: string };

const fmtTapNum = (n: number | null): string => (n == null ? '—' : String(n));
const fmtAbv = (abv: number | null): string =>
  abv == null ? '—' : `${Math.round(abv * 10) / 10}%`;
const fmtRating = (r: number | null): string => (r == null ? '—' : r.toFixed(1));

export function buildBeersMessage(deps: BeersDeps): BeersResult {
  const { db, t } = deps;
  const q = deps.pubQuery?.trim() ?? '';
  if (!q) return { kind: 'no_arg' };

  const matched = filterPubsByQuery(listPubs(db), q);
  if (matched.length === 0) return { kind: 'pub_not_found', query: q };
  if (matched.length >= 2) {
    return {
      kind: 'ambiguous',
      pubs: matched.slice(0, 3).map((p) => ({ name: p.name, address: p.address })),
    };
  }

  const pub = matched[0];
  const snap = latestSnapshot(db, pub.id);
  if (!snap) return { kind: 'empty', pub: pub.name };

  const taps = tapsForSnapshotWithBeer(db, snap.id);
  if (taps.length === 0) return { kind: 'empty', pub: pub.name };

  const address = pub.address ? ` — ${escapeHtml(pub.address)}` : '';
  const header = t('beers.header', {
    pub: escapeHtml(pub.name),
    address,
    count: taps.length,
  });

  const lines = taps.map((tap) => {
    // Empty tap: ontap.pl renders "N/A" as the beer name. Show just the tap
    // number — abv/rating/match-status would all be noise.
    if (tap.beer_ref.trim().toUpperCase() === 'N/A') {
      return `${fmtTapNum(tap.tap_number)} • N/A`;
    }
    const display = tap.brewery_ref
      ? `${tap.brewery_ref} ${tap.beer_ref}`.trim()
      : tap.beer_ref;
    const icon = tap.untappd_id != null ? '🟢' : '⚪';
    return (
      `${fmtTapNum(tap.tap_number)} • <b>${escapeHtml(display)}</b>` +
      ` • ${fmtAbv(tap.abv)} • ${fmtRating(tap.u_rating)} • ${icon}`
    );
  });

  return { kind: 'ok', html: [header, ...lines].join('\n') };
}
