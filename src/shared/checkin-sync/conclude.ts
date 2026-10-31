import { rangeContaining, type CoverageRange } from './coverage';

export interface SyncConclusion {
  caughtUp: boolean;
  nextCursor: string | null;
}

// #924: where the walk steps next, decided the same way on the server and in local mode.
// Moved verbatim from routes/checkins.ts.
export function conclude(state: {
  count: number;
  profileTotal: number | null;
  ranges: readonly CoverageRange[];
  oldest: number;
}): SyncConclusion {
  // Лічильники зійшлися — шукати нижче нічого. Це не твердження про дно стрічки
  // (його довести не можна), а констатація «роботи немає». Але самого збігу чисел
  // не досить: `profile_total` міг ЗМЕНШИТИСЯ (користувач видалив чекін на Untappd,
  // наш рядок лишився) — тому коротке замикання вимагає ще й того, щоб покриття
  // було одним суцільним діапазоном: якщо дір нема, то й іти нікуди.
  const caughtUp = state.profileTotal !== null
    && state.count >= state.profileTotal
    && state.ranges.length === 1;
  const covering = rangeContaining(state.ranges, state.oldest);
  const nextCursor: string | null = caughtUp ? null : String(covering?.from_id ?? state.oldest);

  // #587: обхід зобов'язаний спускатися — клієнт власного запобіжника від циклу не має.
  // Окремої перевірки тут немає, бо спуск випливає з двох вартових checkPage (#854): сторінка
  // пройшла лише з `oldest <= cursor` і без самого курсорного чекіна, тобто `oldest <
  // cursor`; а діапазон, що містить `oldest`, має `from_id <= oldest`. Отже `nextCursor`
  // строго менший за курсор запиту.
  return { caughtUp, nextCursor };
}
