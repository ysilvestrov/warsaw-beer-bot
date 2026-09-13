// #616: межа, через яку глобальний рейтинг Untappd входить у систему. Untappd не показує рейтинг
// пива з менш ніж 10 оцінками: Algolia віддає `rating_score: 0`, сторінка — «Global Rating (N/A)» з
// `data-rating="0"`. Це «рейтингу немає», а не нуль (виміряно: 257/257 нулів мають rating_count ≤ 9).
// Два знаки: Algolia віддає 2, сторінка — 5; без округлення гідратор і refreshAllUntappd по черзі
// перезаписували б рейтинг різницею в тисячні й скидали кеш /match.
export function untappdRating(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}
