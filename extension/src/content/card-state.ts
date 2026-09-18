import type { CardState } from './badge';
import type { MatchResult } from '../api/types';

/**
 * #648: відповідь `/match` → стан картки.
 *
 * Два розрізнення, які легко зліпити й які ламають модель, якщо зліпити:
 *  • «не знайшли» проти «не встигли» розводить `searched`, а не `matched_beer`:
 *    в обох `matched_beer === null`, різниця в тому, чи ми взагалі дивилися;
 *  • сирота в черзі — це `queued`, а не `missing`: рядок є, але питання ще відкрите.
 *    Вердиктом воно стане, коли відповість дошук.
 *
 * `enrichmentPossible` — чи ця картка взагалі поїде в чергу дошуку. Знає це викликач:
 * дошук вимикається опцією, відсутнім токеном і правилом «випите не перелінковуємо».
 */
export function stateFromMatch(
  result: MatchResult,
  opts: { enrichmentPossible: boolean },
): CardState {
  const { brewery, name } = result.raw;
  const matched = result.matched_beer;
  // Асиметрія навмисна. `drunk_uncertain` — це fuzzy-збіг на випите пиво, і сервер
  // (`src/domain/match-list.ts`) виставляє при цьому `is_drunk: false`, тож для «пив»
  // цей прапорець потрібен. А для «непевно» він нічого не додає: сервер не породжує
  // `drunk_uncertain` без `source: 'fuzzy'`, тож `|| result.drunk_uncertain` тут був би
  // недосяжною гілкою, яку жодна мутація не вбиває, — і саме так її й знайшли.
  const drunk = result.is_drunk || result.drunk_uncertain;
  const unsure = result.source === 'fuzzy';

  if (matched !== null && (matched.untappd_id !== null || drunk)) {
    return {
      kind: 'found',
      drunk,
      mine: result.user_rating,
      global: matched.rating_global,
      unsure,
      untappdId: matched.untappd_id,
      brewery,
      name,
    };
  }
  if (opts.enrichmentPossible) return { kind: 'queued' };
  // `orphan: true` стверджує «пиво є в каталозі». Для непевного збігу саме це й під
  // питанням, а варіант `missing` модифікатора непевності не носить — тож на fuzzy
  // кажемо слабше, а не голосніше.
  if (matched !== null) return { kind: 'missing', brewery, name, orphan: !unsure };
  // `!== false`, а не істинність: кеш розширення живе 8 годин і тримає сирі відповіді
  // `/match`, а записи попередньої версії не мають цього поля взагалі (клієнт його не
  // оголошував — у цьому й був дефект). `undefined` при перевірці на істинність упав би
  // на бік `deferred`, і після оновлення кожна незматчена картка до 8 годин казала б
  // «не встигли, перезавантаж» — причому перезавантаження нічого б не змінило, бо читає
  // той самий запис. Відсутнє поле має означати найслабше твердження, а не найсильніше.
  return result.searched !== false
    ? { kind: 'missing', brewery, name, orphan: false }
    : { kind: 'deferred' };
}
