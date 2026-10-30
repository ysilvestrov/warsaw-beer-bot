import type { DB } from './db';
import { normalizeBrewery, normalizeName } from '../domain/normalize';

export interface MissCard {
  brewery: string;
  name: string;
  abv?: number | null;
}

// Journals shop cards /match searched and did not find (spec #923 §1.3). A row says "this card was
// not in the catalog at that moment" — not that it is a beer, nor that Untappd lacks it. Keyed by
// the matcher's own normalizers; raw text, ABV and shop are those of the first sighting.
// seen_days counts distinct Warsaw dates via last_seen_date: slicing the UTC ISO time near
// midnight would credit the wrong day. Same busy_timeout = 0 window as the other /match writes.
// Returns the number of cards recorded.
export function recordMisses(
  db: DB,
  args: { at: string; date: string; shop: string; cards: MissCard[] },
): number {
  if (args.cards.length === 0) return 0;
  const prevBusyTimeout = db.pragma('busy_timeout', { simple: true }) as number;
  db.pragma('busy_timeout = 0');
  try {
    const stmt = db.prepare(`
      INSERT INTO match_misses
        (normalized_brewery, normalized_name, brewery, name, abv, shop,
         first_seen_at, last_seen_at, last_seen_date, seen_days)
      VALUES (@nb, @nn, @brewery, @name, @abv, @shop, @at, @at, @date, 1)
      ON CONFLICT(normalized_brewery, normalized_name) DO UPDATE SET
        seen_days      = seen_days + (last_seen_date <> excluded.last_seen_date),
        last_seen_date = excluded.last_seen_date,
        last_seen_at   = excluded.last_seen_at,
        abv            = COALESCE(abv, excluded.abv)
    `);
    db.transaction(() => {
      for (const c of args.cards) {
        stmt.run({
          nb: normalizeBrewery(c.brewery),
          nn: normalizeName(c.name),
          brewery: c.brewery,
          name: c.name,
          abv: c.abv ?? null,
          shop: args.shop,
          at: args.at,
          date: args.date,
        });
      }
    })();
    return args.cards.length;
  } finally {
    db.pragma(`busy_timeout = ${prevBusyTimeout}`);
  }
}
