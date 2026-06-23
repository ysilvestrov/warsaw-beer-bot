import type { Locale, Translator } from '../../i18n/types';
import type { Filters } from '../../storage/user_filters';
import { cityLabel } from '../../domain/cities';
import { escapeHtml } from './html';

const LOCALE_NAMES: Record<Locale, string> = {
  uk: 'Українська',
  pl: 'Polski',
  en: 'English',
};

export interface StatusView {
  city: string;                 // city slug
  language: Locale | null;
  filters: Filters | null;
  linked: boolean;
  username: string | null;
  synced: number;
  profileTotal: number | null;
  complete: boolean;
  distinctBeers: number;
  lastCheckinAt: string | null; // ISO-ish; only the date part is shown
}

export function summarizeFilters(t: Translator, f: Filters | null): string {
  if (!f) return t('status.filters_none');
  const parts: string[] = [];
  if (f.styles.length) parts.push(t('status.filter_styles', { list: f.styles.join(', ') }));
  if (f.min_rating != null) parts.push(t('status.filter_rating', { rating: f.min_rating }));
  if (f.abv_min != null || f.abv_max != null) {
    parts.push(
      t('status.filter_abv', {
        min: f.abv_min != null ? f.abv_min : '—',
        max: f.abv_max != null ? f.abv_max : '—',
      }),
    );
  }
  if (f.default_route_n != null) parts.push(t('status.filter_route', { n: f.default_route_n }));
  return parts.length ? parts.join(' · ') : t('status.filters_none');
}

// All dynamic values and translated lines are escaped here before being joined,
// because the message is sent with replyWithHTML. Locale strings carry no markup;
// the only HTML is the <b> we add around section headers in code. (See the
// HTML-mode i18n gotcha: never let raw <…> reach Telegram unescaped.)
export function buildStatusMessage(t: Translator, view: StatusView): string {
  const esc = escapeHtml;
  const bold = (s: string): string => `<b>${esc(s)}</b>`;
  const lines: string[] = [];

  lines.push(bold(t('status.title')));
  lines.push('');

  // Settings — always shown, independent of Untappd linking.
  lines.push(bold(t('status.settings_header')));
  lines.push(esc(t('status.city', { name: cityLabel(view.city) })));
  lines.push(
    esc(
      t('status.language', {
        name: view.language ? LOCALE_NAMES[view.language] : t('status.language_auto'),
      }),
    ),
  );
  lines.push(esc(t('status.filters', { summary: summarizeFilters(t, view.filters) })));
  lines.push(esc(t('status.filters_edit')));
  lines.push('');

  // Untappd / sync.
  lines.push(bold(t('status.untappd_header')));
  if (!view.linked) {
    lines.push(esc(t('status.not_linked')));
    return lines.join('\n');
  }
  lines.push(esc(t('status.username', { username: view.username ?? '' })));
  lines.push(
    esc(
      view.profileTotal != null
        ? t('status.checkins_of', { synced: view.synced, total: view.profileTotal })
        : t('status.checkins', { synced: view.synced }),
    ),
  );
  lines.push(esc(view.complete ? t('status.sync_complete') : t('status.sync_in_progress')));
  lines.push(esc(t('status.distinct_beers', { count: view.distinctBeers })));
  lines.push(
    esc(
      view.lastCheckinAt
        ? t('status.last_checkin', { date: view.lastCheckinAt.slice(0, 10) })
        : t('status.no_checkins'),
    ),
  );

  return lines.join('\n');
}
