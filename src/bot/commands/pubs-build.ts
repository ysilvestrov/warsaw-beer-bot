import type { DB } from '../../storage/db';
import type { Translator } from '../../i18n/types';
import { listPubs } from '../../storage/pubs';
import { escapeHtml } from './newbeers-format';

export interface PubsDeps {
  db: DB;
  t: Translator;
}

export function buildPubsMessage(deps: PubsDeps): string {
  const pubs = listPubs(deps.db).sort((a, b) => a.name.localeCompare(b.name));
  if (pubs.length === 0) return deps.t('pubs.empty');
  const lines = pubs.map((p) => `• ${escapeHtml(p.name)}`);
  return [
    escapeHtml(deps.t('pubs.header')),
    '',
    ...lines,
    '',
    escapeHtml(deps.t('pubs.hint')),
  ].join('\n');
}
