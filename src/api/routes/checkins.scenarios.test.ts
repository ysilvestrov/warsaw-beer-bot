import { Hono } from 'hono';
import pino from 'pino';
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile, setUntappdUsername } from '../../storage/user_profiles';
import { hashToken, rotateToken } from '../../storage/api_tokens';
import { coverageFor } from '../../storage/checkin_coverage';
import { authMiddleware } from '../middleware/auth';
import { checkinsRoute } from './checkins';
import type { ApiEnv } from '../types';
import { SYNC_SCENARIOS } from '../../shared/checkin-sync/scenarios';

// #924: the shared scenario table through the real route. The extension's local adapter runs
// the same table (extension/src/local/sync.test.ts), so both sides answer every case the same.
const TOKEN = 'scenario-token';

function setup() {
  const db = openDb(':memory:');
  migrate(db);
  ensureProfile(db, 1);
  setUntappdUsername(db, 1, 'bob');
  rotateToken(db, 1, hashToken(TOKEN), new Date().toISOString());
  const log = pino({ level: 'silent' }) as never;
  const app = new Hono<ApiEnv>();
  app.use('/checkins/*', authMiddleware(db));
  checkinsRoute(app, { db, env: {} as never, log });
  return { db, app };
}

describe('POST /checkins/sync — shared scenarios (#924)', () => {
  it.each(SYNC_SCENARIOS.map((s) => [s.name, s] as const))('%s', async (_name, scenario) => {
    const { db, app } = setup();
    const answers: unknown[] = [];
    for (const step of scenario.steps) {
      const res = await app.request('/checkins/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ html: step.html, maxId: step.maxId }),
      });
      const body = await res.json() as Record<string, unknown>;
      answers.push(res.status === 200
        ? { status: 200, nextCursor: body.nextCursor, merged: body.merged, alreadyKnown: body.alreadyKnown, serverCount: body.serverCount }
        : { status: res.status, error: body.error });
    }
    expect(answers).toEqual(scenario.steps.map((s) => s.expect));
    expect(coverageFor(db, 1)).toEqual(scenario.coverage);
  });
});
