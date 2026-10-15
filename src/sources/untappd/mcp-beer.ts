import { z } from 'zod';
import type { BidBeerInput } from '../../storage/beers';
import { normalizeBrewery, normalizeName } from '../../domain/normalize';
import type { ToolCallResult } from './mcp-client';

// MCP get_beer (probe 2026-10-15): the Untappd v4 body as JSON text, the brewery nested inside the
// beer. Read for a beer taken by link that the bot has never seen (spec
// 2026-10-15-fest-queue-reality-design.md §PR 1); the rest of the ~176 KB body is ignored.

const bodySchema = z.object({
  beer: z.object({
    bid: z.number().int().positive(),
    beer_name: z.string().min(1),
    beer_style: z.string().nullish(),
    beer_abv: z.number().nullish(),
    rating_score: z.number().nullish(),
    brewery: z.object({ brewery_name: z.string().min(1) }),
  }),
});

/** The beer as the catalogue stores it, or null for a tool error or an answer of another shape. */
export function parseMcpBeer(result: ToolCallResult): BidBeerInput | null {
  if (result.isError || !Array.isArray(result.content)) return null;
  // The first text item: the probe saw it at content[0], and an item of another kind before it is not the body.
  const text = (result.content as { type?: unknown; text?: unknown }[]).find((c) => c?.type === 'text' && typeof c.text === 'string')?.text as string | undefined;
  if (text === undefined) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const body = bodySchema.safeParse(json);
  if (!body.success) return null;
  const b = body.data.beer;
  return {
    untappd_id: b.bid,
    name: b.beer_name,
    brewery: b.brewery.brewery_name,
    style: b.beer_style ?? null,
    abv: b.beer_abv ?? null,
    // Untappd sends 0 for a beer nobody has rated yet.
    rating_global: b.rating_score ? b.rating_score : null,
    normalized_name: normalizeName(b.beer_name),
    normalized_brewery: normalizeBrewery(b.brewery.brewery_name),
    untappd_id_source: 'checkin',
  };
}
