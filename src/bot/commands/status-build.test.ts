import { createTranslator } from '../../i18n';
import { buildStatusMessage, summarizeFilters, type StatusView } from './status-build';
import type { Filters } from '../../storage/user_filters';

const t = createTranslator('en');

const base: StatusView = {
  city: 'warszawa',
  language: 'en',
  filters: null,
  linked: true,
  username: 'beerfan',
  synced: 11287,
  profileTotal: 11290,
  complete: true,
  distinctBeers: 842,
  lastCheckinAt: '2024-05-05 20:00:00',
};

describe('summarizeFilters', () => {
  it('returns the "none" label for null filters', () => {
    expect(summarizeFilters(t, null)).toBe(t('status.filters_none'));
  });

  it('joins the active filter parts', () => {
    const f: Filters = { styles: ['IPA', 'Stout'], min_rating: 3.5, abv_min: 5, abv_max: 8, default_route_n: 3 };
    const s = summarizeFilters(t, f);
    expect(s).toContain('IPA, Stout');
    expect(s).toContain('3.5');
    expect(s).toContain('5');
    expect(s).toContain('8');
    expect(s).toContain('3');
    expect(s).toContain('·');
  });

  it('treats an all-empty filter row as "none"', () => {
    const f: Filters = { styles: [], min_rating: null, abv_min: null, abv_max: null, default_route_n: null };
    expect(summarizeFilters(t, f)).toBe(t('status.filters_none'));
  });
});

describe('buildStatusMessage', () => {
  it('shows settings + full sync stats with profile total', () => {
    const out = buildStatusMessage(t, base);
    expect(out).toContain('Warszawa');
    expect(out).toContain('English');
    expect(out).toContain('11287 / 11290');
    expect(out).toContain('beerfan');
    expect(out).toContain('842');
    expect(out).toContain('2024-05-05');
    expect(out).toContain('<b>');
  });

  it('omits the total when profileTotal is null', () => {
    const out = buildStatusMessage(t, { ...base, profileTotal: null });
    expect(out).toContain('Check-ins synced: 11287');
    expect(out).not.toContain('11290');
  });

  it('shows the link nudge and no sync stats when not linked', () => {
    const out = buildStatusMessage(t, { ...base, linked: false, username: null });
    expect(out).toContain(t('status.not_linked'));
    expect(out).not.toContain('Check-ins synced');
    expect(out).toContain('Warszawa');
  });

  it('shows the no-checkins hint when there are none', () => {
    const out = buildStatusMessage(t, { ...base, synced: 0, distinctBeers: 0, lastCheckinAt: null });
    expect(out).toContain(t('status.no_checkins'));
  });

  it('shows deep-sync-in-progress when not complete', () => {
    const out = buildStatusMessage(t, { ...base, complete: false });
    expect(out).toContain(t('status.sync_in_progress'));
  });

  it('renders "auto" when language is unset', () => {
    const out = buildStatusMessage(t, { ...base, language: null });
    expect(out).toContain(t('status.language_auto'));
  });

  it('HTML-escapes an adversarial username', () => {
    const out = buildStatusMessage(t, { ...base, username: 'a<b>&"x' });
    expect(out).toContain('a&lt;b&gt;&amp;');
    expect(out).not.toContain('a<b>&"x');
  });
});
