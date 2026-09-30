// Festival Target list (spec §5): menu beers nobody in the team has had that are worth the
// queue — by rating or by a festival style pattern — adjusted by the team's manual overrides.
// Pure: the caller supplies the menu, each member's tried set and the overrides.

export interface TargetMenuItem {
  beer_id: number;
  section: string;
  rating_global: number | null;
  style: string | null;
}

export interface TargetCriteria {
  minRating: number;
  /** Case-insensitive substrings of the raw Untappd style ("Stout - Imperial / Double"). */
  stylePatterns: string[];
}

export type TargetReason = 'rating' | 'style' | 'manual';

export interface Target {
  beerId: number;
  section: string;
  reasons: TargetReason[];
  rating: number | null;
  style: string | null;
}

export interface TargetsResult {
  targets: Target[];
  /** Untried beers with no rating and no matching style: shown apart, never silently dropped. */
  unrated: TargetMenuItem[];
}

export function computeTargets(input: {
  menu: TargetMenuItem[];
  triedByMember: ReadonlySet<number>[];
  overrides: ReadonlyMap<number, 'add' | 'remove'>;
  criteria: TargetCriteria;
}): TargetsResult {
  // No members means "untried by everyone" is vacuously true for the whole menu; that is not
  // a Target list, it is the menu.
  if (input.triedByMember.length === 0) return { targets: [], unrated: [] };
  const patterns = input.criteria.stylePatterns.map((p) => p.toLowerCase());
  const targets: Target[] = [];
  const unrated: TargetMenuItem[] = [];

  for (const item of input.menu) {
    const override = input.overrides.get(item.beer_id);
    if (override === 'remove') continue;
    const untried = input.triedByMember.every((tried) => !tried.has(item.beer_id));
    const reasons: TargetReason[] = [];
    if (untried && item.rating_global !== null && item.rating_global >= input.criteria.minRating) reasons.push('rating');
    const style = (item.style ?? '').toLowerCase();
    if (untried && style && patterns.some((p) => style.includes(p))) reasons.push('style');
    if (override === 'add') reasons.push('manual');

    if (reasons.length > 0) {
      targets.push({ beerId: item.beer_id, section: item.section, reasons, rating: item.rating_global, style: item.style });
    } else if (untried && item.rating_global === null) {
      unrated.push(item);
    }
  }
  return { targets, unrated };
}
