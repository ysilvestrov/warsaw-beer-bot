import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { ApiDeps, ApiEnv } from '../types';
import { setEnrichFailureReview } from '../../storage/enrich_failures';

const ReviewBody = z.object({
  beer_id: z.number().int().positive(),
  review_class: z.enum(['parser_bug', 'matcher_bug', 'not_on_untappd', 'wontfix']),
  note: z.string().optional(),
});

// Admin maintenance routes. Assumes adminMiddleware has already authenticated.
export function adminRoute(app: Hono<ApiEnv>, deps: ApiDeps): void {
  app.post('/admin/enrich-failures/review', zValidator('json', ReviewBody), (c) => {
    const { beer_id, review_class, note } = c.req.valid('json');
    const updated = setEnrichFailureReview(
      deps.db, beer_id, review_class, note ?? null, new Date().toISOString(),
    );
    if (!updated) return c.json({ error: 'no failure for beer_id' }, 404);
    return c.json({ status: 'reviewed', beer_id, review_class });
  });
}
