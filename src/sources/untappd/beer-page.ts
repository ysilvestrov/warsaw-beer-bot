// Сторінка пива на Untappd. Парсер рейтингу зі сторінки видалено в #616: рейтинги звіряє
// hydrateRatings через Algolia; URL лишається для посилань у повідомленнях бота (beer-link.ts).
export function buildBeerPageUrl(bid: number): string {
  return `https://untappd.com/beer/${bid}`;
}
