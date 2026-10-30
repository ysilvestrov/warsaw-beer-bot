import type { DB } from '../../storage/db';
import type { Principal } from '../types';
import { hashToken, findTelegramIdByHash } from '../../storage/api_tokens';
import { INSTALL_TOKEN_PREFIX, findInstallByHash, touchInstall } from '../../storage/extension_installs';

export type BearerOutcome = { kind: 'none' } | { kind: 'invalid' } | Principal;

/**
 * Resolves the Authorization header to who is calling (spec #923 §2.3). A `wbi_` token is looked up
 * only among installs and anything else only among Telegram tokens, so neither kind can stand in for
 * the other. A missing header is `none`; a header that is present but unparseable or unknown is
 * `invalid`, which every caller answers with 401.
 */
export function resolveBearer(db: DB, header: string | undefined, today: string): BearerOutcome {
  if (header === undefined) return { kind: 'none' };
  const m = header.match(/^Bearer (.+)$/);
  if (!m) return { kind: 'invalid' };
  const hash = hashToken(m[1]);
  if (m[1].startsWith(INSTALL_TOKEN_PREFIX)) {
    const install = findInstallByHash(db, hash);
    if (install === null) return { kind: 'invalid' };
    // last_seen_date is bookkeeping: a busy database must not turn a valid token into a failure.
    try {
      touchInstall(db, install, { date: today });
    } catch {
      // the next request of the day tries again
    }
    return { kind: 'install', ...install, lastSeenDate: today };
  }
  const telegramId = findTelegramIdByHash(db, hash);
  return telegramId === null ? { kind: 'invalid' } : { kind: 'user', telegramId };
}
