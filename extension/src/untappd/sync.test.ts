import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseUntappdCheckinsHTML, parseUntappdBeersHTML, CheckinSyncer } from './sync';
import * as authModule from './auth';
import * as dbModule from '../db/indexed-db';

describe('parseUntappdCheckinsHTML', () => {
  it('correctly parses checkin rows, beer name, brewery, rating, and bid', () => {
    const html = `
      <div class="item" id="checkin_1001" data-checkin-id="1001">
        <div class="text">
          <a href="/user/ton_craft">Ton</a> is drinking <a href="/b/browar-pinta-hazy-morning/1492922">Hazy Morning</a>
          by <a href="/PINTA">Browar PINTA</a> at <a href="/v/craft-pub/123">Craft Pub</a>
        </div>
        <div class="rating-holder">
          <span class="rating rating-425">4.25</span>
        </div>
        <a class="time" data-gregtime="Wed, 28 Oct 2026 12:00:00 +0000">Wed, 28 Oct 2026</a>
      </div>
      <div class="item" id="checkin_1002" data-checkin-id="1002">
        <div class="text">
          <a href="/user/ton_craft">Ton</a> is drinking <a href="/b/trillium-brewing-company-fort-point/234567">Fort Point Pale Ale</a>
          by <a href="/TrilliumBrewing">Trillium Brewing Company</a>
        </div>
        <div class="rating-holder">
          <span class="rating rating-450">4.50</span>
        </div>
        <a class="time" data-gregtime="Wed, 28 Oct 2026 11:30:00 +0000">Wed, 28 Oct 2026</a>
      </div>
      <a class="more_checkins" data-max-id="1002" href="/profile/more_feed/ton_craft/1002?v2=true">Show More</a>
    `;

    const result = parseUntappdCheckinsHTML(html);
    expect(result.items).toHaveLength(2);

    expect(result.items[0]).toEqual({
      checkinId: '1001',
      bid: 1492922,
      beerName: 'Hazy Morning',
      breweryName: 'Browar PINTA',
      userRating: 4.25,
      createdAt: 'Wed, 28 Oct 2026 12:00:00 +0000',
    });

    expect(result.items[1]).toEqual({
      checkinId: '1002',
      bid: 234567,
      beerName: 'Fort Point Pale Ale',
      breweryName: 'Trillium Brewing Company',
      userRating: 4.5,
      createdAt: 'Wed, 28 Oct 2026 11:30:00 +0000',
    });

    expect(result.nextMaxId).toBe('1002');
  });

  it('handles empty markup without crashing', () => {
    const result = parseUntappdCheckinsHTML('<html><body><div>No checkins yet</div></body></html>');
    expect(result.items).toEqual([]);
    expect(result.nextMaxId).toBeNull();
  });
});

describe('parseUntappdBeersHTML', () => {
  it('correctly parses distinct beers markup with styles, ABV, and ratings', () => {
    const sampleHtml = `
      <div class="stats">
        <a href="/user/ton_beer/beers">
          <span class="stat">2,809</span>
          <span class="title">Unique</span>
        </a>
      </div>
      <div class="beer-item" data-bid="6455508">
        <div class="beer-details">
          <p class="name"><a href="/b/kompaan-pint-size-penny/6455508">Pint Size Penny - Foreign Legion 2025</a></p>
          <p class="brewery"><a href="/KompaanBier">KOMPAAN Dutch Craft Beer Company</a></p>
          <p class="style">Stout - Imperial / Double</p>
          <div class="ratings">
            <div class="you">
              <p>Their Rating (4.8)</p>
              <div class="caps" data-rating="4.8"></div>
            </div>
            <div class="you">
              <p>Global Rating (3.81)</p>
              <div class="caps" data-rating="3.81072"></div>
            </div>
          </div>
        </div>
        <div class="details">
          <p class="abv">11% ABV</p>
          <p class="date">Recent: <a><abbr class="date-time">Sat, 02 May 2026 17:53:18 +0200</abbr></a></p>
          <p class="check-ins">Total: 2</p>
        </div>
      </div>
    `;

    const parsed = parseUntappdBeersHTML(sampleHtml);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.totalUniqueFromPage).toBe(2809);

    const item = parsed.items[0];
    expect(item.bid).toBe(6455508);
    expect(item.beerName).toBe('Pint Size Penny - Foreign Legion 2025');
    expect(item.breweryName).toBe('KOMPAAN Dutch Craft Beer Company');
    expect(item.style).toBe('Stout - Imperial / Double');
    expect(item.abv).toBe(11);
    expect(item.userRating).toBe(4.8);
    expect(item.globalRating).toBe(3.81);
    expect(item.checkinsCount).toBe(2);
    expect(item.recentDate).toBe('Sat, 02 May 2026 17:53:18 +0200');
  });

  it('handles N/A ratings and missing fields properly', () => {
    const htmlWithNA = `
      <div class="beer-item" data-bid="9999">
        <div class="beer-details">
          <p class="name"><a href="/b/fresh-hops/9999">Fresh Hops Unrated</a></p>
          <p class="brewery"><a href="/FreshBrew">Fresh Brew</a></p>
        </div>
        <div class="details">
          <p class="check-ins">Total: 1</p>
        </div>
      </div>
    `;

    const parsed = parseUntappdBeersHTML(htmlWithNA);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].userRating).toBeNull();
    expect(parsed.items[0].globalRating).toBeNull();
    expect(parsed.items[0].style).toBeNull();
    expect(parsed.items[0].abv).toBeNull();
  });
});

describe('CheckinSyncer', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('runs sync through /beers and /profile/more_beer paginated requests', async () => {
    vi.spyOn(authModule, 'getAuthState').mockResolvedValue({
      isLoggedIn: true,
      user: {
        username: 'ton_beer',
        name: 'Ton',
        avatar: '',
        totalCheckins: 2863,
        totalBeers: 2,
      },
      lastChecked: Date.now(),
    });
    vi.spyOn(authModule, 'saveAuthState').mockResolvedValue();

    let dbCount = 0;
    vi.spyOn(dbModule, 'countUserHad').mockImplementation(async () => dbCount);
    vi.spyOn(dbModule, 'saveUserHadBatch').mockImplementation(async (items) => {
      dbCount += items.length;
    });
    vi.spyOn(dbModule, 'saveCatalogBeerBatch').mockImplementation(async () => {});

    // Mock fetch for 2 pages
    const page1Html = `
      <div class="stats"><span class="stat">2</span><span class="title">Unique</span></div>
      <div class="beer-item" data-bid="1"><div class="beer-details"><p class="name"><a>Beer 1</a></p><p class="brewery"><a>Brewery 1</a></p></div></div>
    `;
    const page2Html = `
      <div class="beer-item" data-bid="2"><div class="beer-details"><p class="name"><a>Beer 2</a></p><p class="brewery"><a>Brewery 2</a></p></div></div>
    `;

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/user/ton_beer/beers')) {
        return Promise.resolve(new Response(page1Html, { status: 200 }));
      }
      if (url.includes('/profile/more_beer/ton_beer/1')) {
        return Promise.resolve(new Response(page2Html, { status: 200 }));
      }
      return Promise.resolve(new Response('', { status: 200 }));
    });

    const syncer = new CheckinSyncer();
    const progressUpdates: number[] = [];

    const res = await syncer.startSync((p) => {
      progressUpdates.push(p.savedCount);
    });

    expect(res.isComplete).toBe(true);
    expect(res.savedCount).toBe(2);
    expect(res.totalProfileCount).toBe(2);
    expect(progressUpdates).toContain(1);
    expect(progressUpdates).toContain(2);
  });
});
