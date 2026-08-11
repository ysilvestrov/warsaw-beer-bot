import type { DB } from '../storage/db';
import { isKnownCity } from '../domain/cities';
import { getUserCity } from '../storage/user_profiles';

// One predicate behind both the /help filter and the city gate: the city-scoped
// commands need real pubs to filter, which only a real Polish city has (#399).
export function hasCityScopedAccess(db: DB, telegramId: number): boolean {
  return isKnownCity(getUserCity(db, telegramId));
}
