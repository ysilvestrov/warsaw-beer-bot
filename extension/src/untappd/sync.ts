import { saveUserHadBatch, saveCatalogBeerBatch, countUserHad, type UserHadBeer, type CatalogBeer } from '../db/indexed-db';
import { getAuthState, saveAuthState } from './auth';

export interface LocalSyncProgress {
  savedCount: number;
  totalProfileCount: number | null;
  newThisRun: number;
  isComplete: boolean;
}

export type SyncCallback = (progress: LocalSyncProgress) => void;

export interface ParsedBeerListItem {
  bid: number;
  beerName: string;
  breweryName: string;
  style: string | null;
  abv: number | null;
  userRating: number | null;
  globalRating: number | null;
  checkinsCount: number;
  recentDate: string;
}

export interface ParsedCheckinItem {
  checkinId: string;
  bid: number;
  beerName: string;
  breweryName: string;
  userRating: number | null;
  createdAt: string;
}

/**
 * Parses user's distinct beers page (/user/<username>/beers) or AJAX pagination (/profile/more_beer/<username>/<offset>).
 * This endpoint contains the COMPLETE distinct beers history (e.g. all 2,809 beers),
 * unlike activity feed which Untappd caps for non-supporter accounts.
 */
export function parseUntappdBeersHTML(html: string): {
  items: ParsedBeerListItem[];
  hasMore: boolean;
  totalUniqueFromPage?: number;
} {
  const items: ParsedBeerListItem[] = [];

  // Match each .beer-item block: <div class="beer-item" data-bid="12345">...
  const itemRegex = /<div[^>]*class=["'][^"']*beer-item[^"']*["'][^>]*data-bid=["'](\d+)["'][\s\S]*?(?=(?:<div[^>]*class=["'][^"']*beer-item[^"']*["'][^>]*data-bid)|(?:<\/div>\s*<a[^>]*class=["'][^"']*button)|$)/gi;

  let m: RegExpExecArray | null;
  while ((m = itemRegex.exec(html)) !== null) {
    const block = m[0];
    const bid = parseInt(m[1], 10);
    if (!Number.isFinite(bid)) continue;

    // Beer name
    const nameMatch = block.match(/<p class=["']name["'][^>]*>\s*<a[^>]*>([^<]+)<\/a>/i);
    const beerName = nameMatch ? nameMatch[1].replace(/\s+/g, ' ').trim() : '';
    if (!beerName) continue;

    // Brewery name
    const breweryMatch = block.match(/<p class=["']brewery["'][^>]*>\s*<a[^>]*>([^<]+)<\/a>/i);
    const breweryName = breweryMatch ? breweryMatch[1].replace(/\s+/g, ' ').trim() : '';

    // Style
    const styleMatch = block.match(/<p class=["']style["'][^>]*>([^<]+)<\/p>/i);
    const style = styleMatch ? styleMatch[1].replace(/\s+/g, ' ').trim() : null;

    // ABV
    const abvMatch = block.match(/<p class=["']abv["'][^>]*>\s*([0-9.]+)\s*%\s*ABV/i);
    const abv = abvMatch ? parseFloat(abvMatch[1]) : null;

    // Total check-ins for this beer
    const totalCheckinsMatch = block.match(/<p class=["']check-ins["'][^>]*>\s*Total:\s*(\d+)/i);
    const checkinsCount = totalCheckinsMatch ? parseInt(totalCheckinsMatch[1], 10) : 1;

    // Recent date
    const recentDateMatch = block.match(/Recent:\s*<a[^>]*>(?:<abbr[^>]*>)?([^<]+)/i);
    const recentDate = recentDateMatch ? recentDateMatch[1].replace(/\s+/g, ' ').trim() : '';

    // Ratings
    let userRating: number | null = null;
    const userRatingMatch =
      block.match(/(?:Their|My|Your)\s+Rating\s*\(([0-9.]+)\)/i) ||
      block.match(/<div class=["']you["']>\s*<p>(?:Their|My|Your)\s+Rating[\s\S]*?data-rating=["']([0-9.]+)["']/i);
    if (userRatingMatch) {
      userRating = parseFloat(userRatingMatch[1]);
    }

    let globalRating: number | null = null;
    const globalRatingMatch =
      block.match(/Global\s+Rating\s*\(([0-9.]+)\)/i) ||
      block.match(/<div class=["']you["']>\s*<p>Global\s+Rating[\s\S]*?data-rating=["']([0-9.]+)["']/i);
    if (globalRatingMatch) {
      globalRating = parseFloat(globalRatingMatch[1]);
    }

    items.push({
      bid,
      beerName,
      breweryName,
      style,
      abv,
      userRating,
      globalRating,
      checkinsCount,
      recentDate,
    });
  }

  // Parse Unique count if present in sidebar/stats on this page
  let totalUniqueFromPage: number | undefined;
  const uniqueMatch =
    html.match(/<span[^>]*class=["'][^"']*stat[^"']*["'][^>]*>([0-9,\s]+)<\/span>\s*<span[^>]*class=["'][^"']*title[^"']*["'][^>]*>\s*Unique\s*<\/span>/i) ||
    html.match(/href=["'][^"']*\/beers["'][^>]*>[\s\S]*?<span[^>]*class=["'][^"']*stat[^"']*["'][^>]*>([0-9,\s]+)<\/span>/i);
  if (uniqueMatch) {
    totalUniqueFromPage = parseInt(uniqueMatch[1].replace(/[,\s]/g, ''), 10) || undefined;
  }

  const hasMore = items.length > 0;
  return { items, hasMore, totalUniqueFromPage };
}

/**
 * Legacy/activity feed parser (keeps compatibility for activity checkins).
 */
export function parseUntappdCheckinsHTML(html: string): { items: ParsedCheckinItem[]; nextMaxId: string | null } {
  const items: ParsedCheckinItem[] = [];

  const itemRegex = /<div[^>]*class=["'][^"']*item[^"']*["'][^>]*data-checkin-id=["'](\d+)["'][\s\S]*?(?=<div[^>]*class=["'][^"']*item[^"']*["'][^>]*data-checkin-id|\s*$)/gi;

  let match: RegExpExecArray | null;
  while ((match = itemRegex.exec(html)) !== null) {
    const block = match[0];
    const checkinId = match[1];

    const beerMatch = block.match(/href=["']\/b\/[^/]+\/(\d+)["'][^>]*>([^<]+)<\/a>/i);
    if (!beerMatch) continue;

    const bid = parseInt(beerMatch[1], 10);
    const beerName = beerMatch[2].replace(/\s+/g, ' ').trim();

    let breweryName = '';
    const breweryMatch =
      block.match(/by\s+<a[^>]*href=["'](?!\/user\/|\/b\/|\/v\/)([^"']+)["'][^>]*>([^<]+)<\/a>/i) ||
      block.match(/href=["']\/(?:brewery\/[^"']+|[a-zA-Z0-9_\-]+)["'][^>]*>([^<]+)<\/a>/i);
    if (breweryMatch) {
      breweryName = (breweryMatch[2] || breweryMatch[1]).replace(/\s+/g, ' ').trim();
    }

    let userRating: number | null = null;
    const ratingClassMatch = block.match(/class=["'][^"']*rating\s+rating-(\d+)[^"']*["']/i);
    if (ratingClassMatch) {
      const rawInt = parseInt(ratingClassMatch[1], 10);
      userRating = rawInt / 100;
    } else {
      const dataRatingMatch = block.match(/data-rating=["']([0-9.]+)["']/i);
      if (dataRatingMatch) {
        userRating = parseFloat(dataRatingMatch[1]);
      }
    }

    const timeMatch =
      block.match(/data-gregtime=["']([^"']+)["']/i) ||
      block.match(/<a[^>]*class=["']time["'][^>]*>([^<]+)<\/a>/i);
    const createdAt = timeMatch ? timeMatch[1].trim() : '';

    items.push({
      checkinId,
      bid,
      beerName,
      breweryName,
      userRating: userRating !== null && Number.isFinite(userRating) ? userRating : null,
      createdAt,
    });
  }

  let nextMaxId: string | null = null;
  const maxIdMatch =
    html.match(/data-max-id=["'](\d+)["']/i) ||
    html.match(/\/more_feed\/[^/]+\/(\d+)/i);
  if (maxIdMatch) {
    nextMaxId = maxIdMatch[1];
  } else if (items.length > 0) {
    const oldest = items[items.length - 1];
    nextMaxId = oldest.checkinId;
  }

  return { items, nextMaxId };
}

export class CheckinSyncer {
  private abortController: AbortController | null = null;
  private isRunning = false;

  public async startSync(onProgress?: SyncCallback): Promise<LocalSyncProgress> {
    if (this.isRunning) {
      throw new Error('Sync is already in progress');
    }

    const auth = await getAuthState();
    if (!auth.isLoggedIn || !auth.user) {
      throw new Error('Please log in to Untappd first');
    }

    this.isRunning = true;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    let totalSaved = await countUserHad();
    let newThisRun = 0;
    let totalProfileCount = auth.user.totalBeers || auth.user.totalCheckins || null;

    let offset = 0;
    const maxPages = 400; // 400 * 25 = 10,000 distinct beers capability
    let page = 0;

    try {
      while (page < maxPages) {
        if (signal.aborted) break;

        // Step 1: Initial page fetches /user/<username>/beers (contains first 25 beers + exact stats)
        // Step 2..N: Paginated AJAX requests to /profile/more_beer/<username>/<offset>
        const url = offset === 0
          ? `https://untappd.com/user/${encodeURIComponent(auth.user.username)}/beers`
          : `https://untappd.com/profile/more_beer/${encodeURIComponent(auth.user.username)}/${offset}`;

        const res = await fetch(url, {
          credentials: 'include',
          headers: offset > 0 ? { 'X-Requested-With': 'XMLHttpRequest' } : undefined,
          signal,
        });

        if (!res.ok) {
          if (res.status === 403 || res.status === 429) {
            throw new Error('Untappd rate limit reached. Please try again in a few minutes.');
          }

          // If more_beer returned 404 or other code, try alternate query param offset fallback
          if (offset > 0) {
            const fallbackUrl = `https://untappd.com/user/${encodeURIComponent(auth.user.username)}/beers?offset=${offset}`;
            const fbRes = await fetch(fallbackUrl, { credentials: 'include', signal });
            if (fbRes.ok) {
              const html = await fbRes.text();
              const parsed = parseUntappdBeersHTML(html);
              if (parsed.items.length > 0) {
                await this.saveBatch(parsed.items);
                newThisRun += parsed.items.length;
                totalSaved = await countUserHad();
                offset += parsed.items.length;
                page++;
                if (onProgress) {
                  onProgress({ savedCount: totalSaved, totalProfileCount, newThisRun, isComplete: false });
                }
                await new Promise((r) => setTimeout(r, 600));
                continue;
              }
            }
          }
          break;
        }

        const html = await res.text();
        const parsed = parseUntappdBeersHTML(html);

        if (parsed.totalUniqueFromPage && parsed.totalUniqueFromPage > 0) {
          totalProfileCount = parsed.totalUniqueFromPage;
          if (auth.user) {
            auth.user.totalBeers = totalProfileCount;
          }
        }

        if (parsed.items.length === 0) {
          // If first request returned 0 items from /beers (e.g. redirected or empty),
          // fallback to checkin activity feed as backup
          if (offset === 0) {
            await this.syncViaFeedFallback(auth.user.username, signal, (p) => {
              totalSaved = p.savedCount;
              newThisRun = p.newThisRun;
              if (onProgress) onProgress(p);
            });
          }
          break;
        }

        // Save parsed distinct beers
        await this.saveBatch(parsed.items);
        newThisRun += parsed.items.length;
        totalSaved = await countUserHad();
        offset += parsed.items.length;
        page++;

        if (onProgress) {
          onProgress({
            savedCount: totalSaved,
            totalProfileCount,
            newThisRun,
            isComplete: false,
          });
        }

        // If we reached or exceeded the total distinct beers from profile, we're done!
        if (totalProfileCount && totalSaved >= totalProfileCount) {
          break;
        }

        // Polite delay between requests to respect Untappd servers
        await new Promise((r) => setTimeout(r, 600));
      }

      // Update user stats in storage
      if (auth.user) {
        auth.user.totalBeers = Math.max(auth.user.totalBeers || 0, totalSaved);
        await saveAuthState(auth);
      }

      const finalProgress: LocalSyncProgress = {
        savedCount: totalSaved,
        totalProfileCount,
        newThisRun,
        isComplete: true,
      };

      if (onProgress) onProgress(finalProgress);
      return finalProgress;
    } finally {
      this.isRunning = false;
      this.abortController = null;
    }
  }

  private async saveBatch(items: ParsedBeerListItem[]): Promise<void> {
    const hadEntries: Omit<UserHadBeer, 'normalizedKey'>[] = items.map((it) => ({
      bid: it.bid,
      name: it.beerName,
      brewery: it.breweryName,
      rating: it.userRating,
      checkinDate: it.recentDate,
      count: it.checkinsCount,
    }));

    const catalogEntries: Omit<CatalogBeer, 'normalizedKey' | 'cachedAt'>[] = items.map((it) => ({
      bid: it.bid,
      name: it.beerName,
      brewery: it.breweryName,
      abv: it.abv ?? undefined,
      style: it.style ?? undefined,
      ratingGlobal: it.globalRating,
    }));

    await saveUserHadBatch(hadEntries);
    await saveCatalogBeerBatch(catalogEntries);
  }

  private async syncViaFeedFallback(
    username: string,
    signal: AbortSignal,
    onProgress?: SyncCallback
  ): Promise<void> {
    let cursor: string | null = null;
    let page = 0;
    let newThisRun = 0;

    while (page < 100) {
      if (signal.aborted) break;

      const url = cursor === null
        ? `https://untappd.com/user/${encodeURIComponent(username)}`
        : `https://untappd.com/profile/more_feed/${encodeURIComponent(username)}/${encodeURIComponent(cursor)}?v2=true`;

      const res = await fetch(url, {
        credentials: 'include',
        headers: cursor !== null ? { 'X-Requested-With': 'XMLHttpRequest' } : undefined,
        signal,
      });

      if (!res.ok) break;

      const html = await res.text();
      const parsed = parseUntappdCheckinsHTML(html);
      if (parsed.items.length === 0) break;

      const hadEntries: Omit<UserHadBeer, 'normalizedKey'>[] = parsed.items.map((it) => ({
        bid: it.bid,
        name: it.beerName,
        brewery: it.breweryName,
        rating: it.userRating,
        checkinDate: it.createdAt,
        count: 1,
      }));

      await saveUserHadBatch(hadEntries);
      newThisRun += hadEntries.length;
      const totalSaved = await countUserHad();
      page++;

      if (onProgress) {
        onProgress({
          savedCount: totalSaved,
          totalProfileCount: null,
          newThisRun,
          isComplete: false,
        });
      }

      if (!parsed.nextMaxId || parsed.nextMaxId === cursor) break;
      cursor = parsed.nextMaxId;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  public stopSync(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.isRunning = false;
  }

  public getActiveStatus(): boolean {
    return this.isRunning;
  }
}

export const checkinSyncer = new CheckinSyncer();
