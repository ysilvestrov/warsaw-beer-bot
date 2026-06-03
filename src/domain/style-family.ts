import { baseNormalize } from './normalize';

export const OTHER_FAMILY = 'Other';

interface FamilyRule {
  family: string;
  keywords: string[];
}

// Ordered: first matching rule wins, so order encodes priority.
// "Loud" families (IPA, Stout, Porter) precede Sour so that "Pastry Stout" /
// "Pastry Porter" resolve to their base family rather than Sour's `pastry`
// keyword. Pale Ale is special-cased (see canonicalStyleFamily) to avoid
// swallowing "Pale Lager".
export const FAMILY_RULES: ReadonlyArray<FamilyRule> = [
  { family: 'IPA', keywords: ['ipa', 'aipa', 'neipa', 'dipa', 'tipa', 'wcipa', 'neneipa'] },
  { family: 'Stout', keywords: ['stout'] },
  { family: 'Porter', keywords: ['porter'] },
  { family: 'Sour', keywords: ['sour', 'gose', 'kwasne', 'kwasny', 'pastry'] },
  { family: 'Lambic', keywords: ['lambic', 'gueuze'] },
  { family: 'Saison', keywords: ['saison'] },
  { family: 'Pale Ale', keywords: ['apa'] }, // 'pale'+'ale' handled in canonicalStyleFamily
  { family: 'Wheat', keywords: ['weizen', 'hefeweizen', 'witbier', 'wit', 'pszeniczne', 'pszenica', 'pszeniczny', 'wheat'] },
  { family: 'Lager', keywords: ['lager', 'pils', 'pilsner', 'lezak', 'helles', 'dunkel', 'vienna', 'marzen', 'desitka'] },
  { family: 'Bock', keywords: ['bock'] },
  { family: 'Barleywine', keywords: ['barleywine', 'barley'] },
];

export function canonicalStyleFamily(style: string | null): string {
  if (style == null) return OTHER_FAMILY;
  const tokens = new Set(baseNormalize(style).split(' ').filter(Boolean));
  if (tokens.size === 0) return OTHER_FAMILY;
  for (const rule of FAMILY_RULES) {
    if (rule.family === 'Pale Ale') {
      if (tokens.has('apa') || (tokens.has('pale') && tokens.has('ale'))) return 'Pale Ale';
      continue;
    }
    if (rule.keywords.some((k) => tokens.has(k))) return rule.family;
  }
  return OTHER_FAMILY;
}
