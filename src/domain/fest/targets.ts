// Festival Target list (spec §5): menu beers nobody in the team has had that are worth the
// queue — by rating, by a festival style pattern, by strength or by a festival name pattern —
// adjusted by the team's manual overrides.
// Pure: the caller supplies the menu, each member's tried set and the overrides.

export interface TargetMenuItem {
  beer_id: number;
  section: string;
  name: string;
  rating_global: number | null;
  style: string | null;
  /** The catalogue stores an unknown strength as null or 0; neither qualifies, whatever the threshold. */
  abv: number | null;
}

export interface TargetCriteria {
  minRating: number;
  /** null: the festival has no strength rule. */
  minAbv: number | null;
  /** Case-insensitive substrings of the raw Untappd style ("Stout - Imperial / Double"). */
  stylePatterns: string[];
  /**
   * Case-insensitive substrings of the beer name: how a festival marks the beers brewed for it
   * ("WFP"). A blank pattern is ignored — it would match every name.
   */
  namePatterns: string[];
}

export type TargetReason = 'rating' | 'style' | 'abv' | 'name' | 'manual';

export interface Target {
  beerId: number;
  section: string;
  reasons: TargetReason[];
  rating: number | null;
  style: string | null;
}

export interface TargetsResult {
  targets: Target[];
  /** Untried beers with no rating and no automatic reason: shown apart, never silently dropped. */
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
  const namePatterns = input.criteria.namePatterns.map((p) => p.trim().toLowerCase()).filter((p) => p !== '');
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
    // 0 is the catalogue's "unknown strength", not a strength: it qualifies under no threshold.
    const abv = item.abv !== null && item.abv > 0 ? item.abv : null;
    if (untried && input.criteria.minAbv !== null && abv !== null && abv >= input.criteria.minAbv) reasons.push('abv');
    const name = item.name.toLowerCase();
    if (untried && namePatterns.some((p) => name.includes(p))) reasons.push('name');
    if (override === 'add') reasons.push('manual');

    if (reasons.length > 0) {
      targets.push({ beerId: item.beer_id, section: item.section, reasons, rating: item.rating_global, style: item.style });
    } else if (untried && item.rating_global === null) {
      unrated.push(item);
    }
  }
  return { targets, unrated };
}
