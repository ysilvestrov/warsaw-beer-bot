import type { Target } from './targets';
import type { TapStatus } from './tap-status';

// Where to go first (spec §6.3): menu sections (≈ exhibitors) ordered by Targets poured now,
// then by Targets we cannot see, then by all Targets, then by name. A section with no Target
// is not listed.

export interface SectionRank {
  section: string;
  onTap: number;
  unknown: number;
  total: number;
  targets: Target[];
}

export function rankSections(targets: Target[], statusByBeer: ReadonlyMap<number, TapStatus>): SectionRank[] {
  const bySection = new Map<string, SectionRank>();
  for (const t of targets) {
    const row = bySection.get(t.section) ?? { section: t.section, onTap: 0, unknown: 0, total: 0, targets: [] };
    const kind = statusByBeer.get(t.beerId)?.kind ?? 'unknown';
    if (kind === 'on_tap') row.onTap++;
    if (kind === 'unknown') row.unknown++;
    row.total++;
    row.targets.push(t);
    bySection.set(t.section, row);
  }
  return [...bySection.values()].sort((a, b) =>
    b.onTap - a.onTap || b.unknown - a.unknown || b.total - a.total || a.section.localeCompare(b.section),
  );
}
