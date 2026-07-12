import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { z } from 'zod';
import { findTelegramIdByHash, hashToken } from '../../storage/api_tokens';
import type { ApiDeps, ApiEnv } from '../types';

export const MIB = 1024 * 1024;
export const KIB = 1024;
export const GLOBAL_BODY_LIMIT_BYTES = 4 * MIB;
export const CHECKINS_SYNC_BODY_LIMIT_BYTES = 1 * MIB;
export const ENRICH_RESULT_BODY_LIMIT_BYTES = 512 * KIB;
export const MATCH_BODY_LIMIT_BYTES = 256 * KIB;
export const ENRICH_CANDIDATES_BODY_LIMIT_BYTES = 256 * KIB;
export const CHECKINS_HTML_LIMIT_CHARS = 768 * KIB;
export const ENRICH_HTML_LIMIT_CHARS = 384 * KIB;
export const BEER_TEXT_LIMIT_CHARS = 512;
export const PAGE_URL_LIMIT_CHARS = 2048;
export const CURSOR_LIMIT_CHARS = 512;

type RejectionLayer = 'global' | 'route' | 'schema';
type Identity =
  | { auth: 'anonymous' }
  | { auth: 'invalid' }
  | { auth: 'authenticated'; telegramId: number };

function identityForRejection(c: Context<ApiEnv>, deps: ApiDeps): Identity {
  const contextTelegramId = c.get('telegramId');
  if (typeof contextTelegramId === 'number' && Number.isFinite(contextTelegramId)) {
    return { auth: 'authenticated', telegramId: contextTelegramId };
  }

  const header = c.req.header('Authorization');
  if (header === undefined) return { auth: 'anonymous' };
  const match = header.match(/^Bearer (.+)$/);
  if (!match) return { auth: 'invalid' };
  const telegramId = findTelegramIdByHash(deps.db, hashToken(match[1]));
  return telegramId === null
    ? { auth: 'invalid' }
    : { auth: 'authenticated', telegramId };
}

function contentLength(c: Context<ApiEnv>): number | null {
  const raw = c.req.header('Content-Length');
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function rejectPayload(
  c: Context<ApiEnv>,
  deps: ApiDeps,
  rejectionLayer: RejectionLayer,
  limit: number,
  limitUnit: 'bytes' | 'characters',
  fieldPath?: string,
) {
  deps.log.warn(
    {
      method: c.req.method,
      path: c.req.path,
      rejectionLayer,
      limit,
      limitUnit,
      contentLength: contentLength(c),
      ...identityForRejection(c, deps),
      ...(fieldPath === undefined ? {} : { fieldPath }),
    },
    'api payload too large',
  );
  return c.json({ error: 'payload_too_large' } as const, 413);
}

export function payloadBodyLimit(
  deps: ApiDeps,
  maxSize: number,
  rejectionLayer: 'global' | 'route',
): MiddlewareHandler<ApiEnv> {
  return bodyLimit({
    maxSize,
    onError: (c) => rejectPayload(c as Context<ApiEnv>, deps, rejectionLayer, maxSize, 'bytes'),
  });
}

export function payloadSizeValidationHook(deps: ApiDeps) {
  return (result: z.ZodSafeParseResult<unknown>, c: Context<ApiEnv>) => {
    if (result.success) return undefined;
    const issue = result.error.issues.find(
      (candidate) => candidate.code === 'too_big' && candidate.origin === 'string',
    );
    if (!issue || issue.code !== 'too_big') return undefined;
    return rejectPayload(
      c,
      deps,
      'schema',
      Number(issue.maximum),
      'characters',
      issue.path.join('.'),
    );
  };
}
