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
  distinctBeers: 842,
  lastCheckinAt: '2024-05-05 20:00:00',
  lastSyncAt: '2026-09-03 22:19:05',
  hadWithoutCheckins: 0,
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
    expect(out).not.toContain('✅');
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

  it.each([12428, 12429])('does not claim completeness when synced is %s and total is 12428', (synced) => {
    const out = buildStatusMessage(t, { ...base, synced, profileTotal: 12428 });
    expect(out).toContain(`${synced} / 12428`);
    expect(out).not.toContain('✅');
    expect(out).toContain('Last sync activity: 2026-09-03 22:19:05 UTC');
    expect(out).toContain('Untappd total is from the last sync.');
  });

  it('states that no extension sync has run when sync activity is unknown', () => {
    const out = buildStatusMessage(t, { ...base, profileTotal: null, lastSyncAt: null });
    expect(out).toContain('No extension sync yet.');
    expect(out).not.toContain('UTC');
    expect(out).not.toContain('Untappd total is from the last sync.');
  });

  it('reports missing beer check-ins without claiming when the beers were consumed', () => {
    const out = buildStatusMessage(t, { ...base, hadWithoutCheckins: 53 });
    expect(out).toContain('Beers known to the server without imported check-ins: 53. Run “Sync my check-ins” in the extension.');
    expect(buildStatusMessage(t, base)).not.toContain('without imported check-ins');
  });

  it.each([
    ['uk', 'Остання активність синхронізації: 2026-09-03 22:19:05 UTC', 'Пив, відомих серверу без імпортованих чекінів: 53.'],
    ['pl', 'Ostatnia aktywność synchronizacji: 2026-09-03 22:19:05 UTC', 'Piwa znane serwerowi bez zaimportowanych check-inów: 53.'],
    ['en', 'Last sync activity: 2026-09-03 22:19:05 UTC', 'Beers known to the server without imported check-ins: 53.'],
  ] as const)('localizes sync activity and missing-beer evidence in %s', (locale, syncLine, missingLine) => {
    const out = buildStatusMessage(createTranslator(locale), { ...base, hadWithoutCheckins: 53 });
    expect(out).toContain(syncLine);
    expect(out).toContain(missingLine);
    expect(out).toContain('Sync my check-ins');
    expect(out).not.toContain('✅');
  });

  it('does not append ✅ when synced exceeds profileTotal is false (behind)', () => {
    const out = buildStatusMessage(t, { ...base, synced: 100, profileTotal: 12428 });
    expect(out).toContain('100 / 12428');
    expect(out).not.toContain('✅');
  });

  it('shows no ✅ and no separate sync line when profileTotal is unknown', () => {
    const out = buildStatusMessage(t, { ...base, profileTotal: null });
    expect(out).toContain('Check-ins synced: 11287');
    expect(out).not.toContain('✅');
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

  it('renders the outside-Poland pseudo-city with its localized label (#399)', () => {
    const out = buildStatusMessage(t, { ...base, city: 'outside-pl' });
    expect(out).toContain('🌍 Outside Poland');
    expect(out).not.toContain('outside-pl');
  });
});
