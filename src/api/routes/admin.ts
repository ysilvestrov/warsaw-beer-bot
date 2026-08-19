import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { ApiDeps, ApiEnv } from '../types';
import { setEnrichFailureReview } from '../../storage/enrich_failures';
import { REVIEW_CLASSES } from '../../domain/review-class';

const ReviewBody = z.object({
  beer_id: z.number().int().positive(),
  review_class: z.enum(REVIEW_CLASSES),
  note: z.string().nullable().optional(), // accept explicit null (clear/no note) as well as omitted
});

// Admin maintenance routes. Assumes adminMiddleware has already authenticated.
export function adminRoute(app: Hono<ApiEnv>, deps: ApiDeps): void {
  app.post('/admin/enrich-failures/review', zValidator('json', ReviewBody), (c) => {
    const { beer_id, review_class, note } = c.req.valid('json');
    // No `evidence` argument: an admin operator typing a class into a form has not
    // proved absence any more than the LLM job has, so this route can never assert
    // not_on_untappd — it inherits the chokepoint's default refusal.
    const result = setEnrichFailureReview(
      deps.db, beer_id, review_class, note ?? null, new Date().toISOString(),
    );
    if (result === 'no_row') return c.json({ error: 'no failure for beer_id' }, 404);
    if (result !== 'written') return c.json({ error: result }, 422);
    return c.json({ status: 'reviewed', beer_id, review_class });
  });
}
