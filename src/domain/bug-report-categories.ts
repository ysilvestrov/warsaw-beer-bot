import type { CategoryDef, ReportSource } from './bug-report-types';

export const CATEGORIES: readonly CategoryDef[] = [
  { key: 'wrong_beer', sources: ['bot', 'extension'], hintLabel: 'matcher-bug' },
  { key: 'no_rating', sources: ['bot', 'extension'], hintLabel: 'matcher-bug' },
  { key: 'had_status', sources: ['bot', 'extension'], hintLabel: 'bug' },
  { key: 'stale_data', sources: ['bot', 'extension'], hintLabel: 'parser-bug' },
  { key: 'route', sources: ['bot'], hintLabel: 'bug' },
  { key: 'no_badge', sources: ['extension'], hintLabel: 'extension-bug' },
  { key: 'ext_broken', sources: ['extension'], hintLabel: 'extension-bug' },
  { key: 'bot_broken', sources: ['bot'], hintLabel: 'bug' },
  { key: 'text_ui', sources: ['bot', 'extension'], hintLabel: 'bug' },
  { key: 'other', sources: ['bot', 'extension'], hintLabel: 'bug' },
];

export function categoriesFor(source: ReportSource): CategoryDef[] {
  return CATEGORIES.filter((category) => category.sources.includes(source));
}
