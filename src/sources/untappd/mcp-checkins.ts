import { z } from 'zod';
import { feedCheckinTime } from './checkin-feed';

// Check-ins from the Untappd MCP (spec §4.5): get_my_friend_feed and get_user_checkins answer with
// the Untappd v4 body as JSON text in content[0].text (probe 2026-09-30). Only the fields the
// festival needs are read; a record that lacks one is dropped alone, the rest of the page lives.

export interface McpCheckin {
  checkinId: number;
  /** ISO-8601 UTC with 'Z'; only a time with seconds is accepted (as for the HTML feeds). */
  checkinAt: string;
  bid: number;
  beerName: string;
  breweryName: string;
  style: string | null;
  abv: number | null;
  /** null when Untappd sends `venue: []` (a check-in without a place). */
  venueId: number | null;
  userName: string;
  rating: number | null;
}

/**
 * `cached` is true unless the body says `mem: false`: Untappd marks a page it served from its own
 * cache with `mem: true`, and such a page does not show the venue as it is now (spec
 * 2026-10-02-wfp-mcp-venue-eye-design.md §3.2). A body without the field is not vouched for either.
 */
export type McpPage = { items: McpCheckin[]; count: number; cached: boolean } | { error: string };

const recordSchema = z.object({
  checkin_id: z.number().int().positive(),
  created_at: z.string(),
  rating_score: z.number().nullish(),
  user: z.object({ user_name: z.string().min(1) }),
  beer: z.object({
    bid: z.number().int().positive(),
    beer_name: z.string(),
    beer_style: z.string().nullish(),
    beer_abv: z.number().nullish(),
  }),
  brewery: z.object({ brewery_name: z.string() }),
  venue: z.union([z.object({ venue_id: z.number().int().positive() }), z.array(z.unknown()).length(0)]),
});

const bodySchema = z.object({ mem: z.unknown().optional(), checkins: z.object({ items: z.array(z.unknown()) }) });

interface ToolResult {
  isError?: boolean;
  content?: unknown;
}

function firstText(result: ToolResult): string | null {
  if (!Array.isArray(result.content)) return null;
  const first = result.content[0] as { type?: unknown; text?: unknown } | undefined;
  return first && first.type === 'text' && typeof first.text === 'string' ? first.text : null;
}

/**
 * One page of check-ins. `count` is the number of records Untappd sent (before any were dropped):
 * paging decides on it, since a full page means there may be more below (spec §4.5).
 */
export function parseMcpCheckins(result: ToolResult): McpPage {
  const text = firstText(result);
  if (result.isError) return { error: text ?? 'tool_error' };
  if (text === null) return { error: 'bad_shape' };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { error: 'bad_shape' };
  }
  const body = bodySchema.safeParse(json);
  if (!body.success) return { error: 'bad_shape' };
  const items: McpCheckin[] = [];
  for (const raw of body.data.checkins.items) {
    const r = recordSchema.safeParse(raw);
    if (!r.success) continue;
    const at = feedCheckinTime(r.data.created_at);
    if (at === null) continue;
    items.push({
      checkinId: r.data.checkin_id,
      checkinAt: at,
      bid: r.data.beer.bid,
      beerName: r.data.beer.beer_name,
      breweryName: r.data.brewery.brewery_name,
      style: r.data.beer.beer_style ?? null,
      abv: r.data.beer.beer_abv ?? null,
      venueId: Array.isArray(r.data.venue) ? null : r.data.venue.venue_id,
      userName: r.data.user.user_name,
      // The API sends 0 for a check-in without a rating.
      rating: r.data.rating_score ? r.data.rating_score : null,
    });
  }
  return { items, count: body.data.checkins.items.length, cached: body.data.mem !== false };
}
