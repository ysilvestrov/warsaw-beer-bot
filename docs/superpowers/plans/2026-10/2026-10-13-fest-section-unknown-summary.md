# План: /fest — один рядок «без статусу» на секцію

Спека: `docs/superpowers/specs/2026-10/2026-10-13-fest-section-unknown-summary-design.md`.
Одна дрібна задача: повний код нижче, два файли плюс локалі й тест, нових рішень нема. Її виконує
контролер інлайн, з повним гейтом.

## Задача 1 — рендер і локалі

1. `src/bot/commands/fest-format.ts`:
   - `statusLabel(t, s, now): string | null` повертає `null`, коли `!s || s.kind === 'unknown'`.
   - У `formatSection` голова така: `[заголовок, ...(rank.unknown > 0 ? [t('fest.section_unknown', { count: rank.unknown })] : []), '']`.
   - Елемент: назва й рейтинг, а рядок `\n   <статус>` лише коли `statusLabel` не `null`.
2. `src/i18n/types.ts` і `src/i18n/locales/{uk,en,pl}.ts`: `fest.status_unknown` → `fest.section_unknown`:
   - uk: `❔ без статусу: {count} — ми не бачили всю годину`
   - en: `❔ no status: {count} — we did not see the whole hour`
   - pl: `❔ bez statusu: {count} — nie widzieliśmy całej godziny`
3. Тести (`fest-format.test.ts`): як у спеці, розділ «Тести».
4. `spec.md`: у пункті «Бот `/fest`» — речення про те, як деталі секції показують статус.
5. Гейт: `npm test && npm run typecheck`. Мутація: якщо прибрати умову `rank.unknown > 0`, тест «секція без
   unknown» червоніє; якщо повернути рядок для `unknown`, червоніють тести секції.
