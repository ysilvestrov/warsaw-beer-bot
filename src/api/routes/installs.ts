import { randomBytes } from 'crypto';
import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { ApiDeps, ApiEnv } from '../types';
import { hashToken } from '../../storage/api_tokens';
import { INSTALL_TOKEN_PREFIX, REGISTRATIONS_PER_DAY, deleteInstall, registerInstall } from '../../storage/extension_installs';
import { warsawDateAndHour } from '../../domain/warsaw-time';
import { sendThrottledAlert } from '../../jobs/alert-slot';
import { resolveBearer } from '../middleware/resolve-bearer';

const DAY_MS = 24 * 60 * 60 * 1000;
export const CAP_ALERT_KEY = 'install_registrations_cap_alert';

const RegisterBody = z.object({ version: z.string().min(1).max(32) });

// Registers POST /installs and DELETE /installs/me (spec #923 §2.1–2.2). Registration needs no
// token: it is how an install without Telegram gets one. The route never reads the client IP —
// the per-IP limit lives in front of the app (Cloudflare), the global daily cap lives here.
export function installsRoute(app: Hono<ApiEnv>, deps: ApiDeps): void {
  app.post('/installs', zValidator('json', RegisterBody), async (c) => {
    const { version } = c.req.valid('json');
    const now = new Date();
    const raw = INSTALL_TOKEN_PREFIX + randomBytes(32).toString('hex');
    const out = registerInstall(deps.db, {
      date: warsawDateAndHour(now).date,
      at: now.toISOString(),
      version,
      tokenHash: hashToken(raw),
    });
    if (out.kind === 'ok') return c.json({ install_id: out.installId, token: raw }, 201);

    const notify = deps.notifyAdmin;
    if (notify) {
      // Not awaited: the slot is claimed synchronously, so a burst of refusals still sends one alert.
      void sendThrottledAlert(deps.db, {
        key: CAP_ALERT_KEY,
        everyMs: DAY_MS,
        now,
        send: () => notify(
          `Розширення: досягнуто стелі ${REGISTRATIONS_PER_DAY} реєстрацій установок за добу — ` +
          'реєстрації відхиляються до кінця доби (Варшава)',
        ),
      }).catch((e) => deps.log.warn({ err: e }, 'install cap alert failed'));
    }
    return c.json({ error: 'registrations_capped' }, 429);
  });

  // Only an install token deletes an install, and only its own: the token is the identity.
  app.delete('/installs/me', (c) => {
    const who = resolveBearer(deps.db, c.req.header('Authorization'), warsawDateAndHour(new Date()).date);
    if (who.kind !== 'install') return c.json({ error: 'unauthorized' }, 401);
    deleteInstall(deps.db, who.installId);
    return c.body(null, 204);
  });
}
