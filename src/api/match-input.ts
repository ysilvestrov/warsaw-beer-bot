import { z } from 'zod';
import { BEER_TEXT_LIMIT_CHARS } from './middleware/payload-limit';

// Shared by POST /match (routes/match.ts, wrapped in z.object({ beers: ... }) for
// zValidator) and the MCP match_beers tool (mcp/server.ts, used directly as the raw
// shape registerTool expects). One definition of the per-item text cap and the batch
// bounds, so a limit change reaches both call sites instead of silently diverging.
//
// #633: /match extends the ITEM (bid + brand) in its own module; the MCP tool keeps the
// base item — an AI agent has no shop page and therefore no published bid.
export const matchBeerItemSchema = z.object({
  brewery: z.string().max(BEER_TEXT_LIMIT_CHARS),
  name: z.string().max(BEER_TEXT_LIMIT_CHARS),
  abv: z.number().optional(),
});

export const matchBeersArraySchema = z.array(matchBeerItemSchema).min(1).max(200);
