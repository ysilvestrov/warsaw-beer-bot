import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { feedCheckinTime, parseCheckinFeedPage } from './checkin-feed';

const html = readFileSync(join(__dirname, '__fixtures__/checkin-feed-page.html'), 'utf8');

describe('venue feeds (festival probe fixtures)', () => {
  it('prefers data-gregtime over the browser-collapsed date text and reads the author', () => {
    const dom = parseCheckinFeedPage(readFileSync(join(__dirname, '__fixtures__/venue-activity-dom.html'), 'utf8'));
    expect(dom.checkins.map((c) => [c.checkin_id, c.bid, c.author, c.checkin_at])).toEqual([
      ['1600770333', 5703496, 'bockje', 'Fri, 11 Sep 2026 20:45:58 +0000'],
      ['1573215662', 5995292, 'bockje', 'Tue, 26 May 2026 00:11:50 +0000'],
      ['1562430582', 4000001, 'Piwny_John', '12 Apr 26'],
    ]);
  });

  it('reads the RFC time from the text of a raw more_feed fragment', () => {
    const raw = parseCheckinFeedPage(readFileSync(join(__dirname, '__fixtures__/venue-more-feed-raw.html'), 'utf8'));
    expect(raw.checkins.map((c) => [c.checkin_id, c.author, c.checkin_at])).toEqual([
      ['1559318905', 'Bierfluenzer', 'Tue, 31 Mar 2026 12:14:19 +0000'],
      ['1559318837', 'Bierfluenzer', 'Tue, 31 Mar 2026 12:13:15 +0000'],
      ['1559318775', 'Bierfluenzer', 'Tue, 31 Mar 2026 12:12:08 +0000'],
    ]);
    expect(raw.nextMaxId).toBe('1559318775');
  });

  it('falls back to the first /user/ link when no a.user is marked, and to null without one', () => {
    const item = (text: string) => `<div class="item" data-checkin-id="1"><p class="text">${text}
      <a href="/b/x/2">X</a> by <a href="/Brew">Brew</a></p><a class="time">Tue, 31 Mar 2026 12:12:08 +0000</a></div>`;
    expect(parseCheckinFeedPage(item('<a href="/user/some.one">S</a> is drinking')).checkins[0].author).toBe('some.one');
    expect(parseCheckinFeedPage(item('Someone is drinking')).checkins[0].author).toBeNull();
  });
});

describe('feedCheckinTime', () => {
  it('turns an RFC time into ISO UTC', () => {
    expect(feedCheckinTime('Tue, 31 Mar 2026 12:13:15 +0000')).toBe('2026-03-31T12:13:15.000Z');
  });

  it('rejects a date without a time', () => {
    expect(feedCheckinTime('11 Sep 26')).toBeNull();
  });

  it('rejects empty and unparseable input', () => {
    expect([feedCheckinTime(''), feedCheckinTime('   '), feedCheckinTime('yesterday')]).toEqual([null, null, null]);
  });
});

describe('parseCheckinFeedPage', () => {
  const out = parseCheckinFeedPage(html);

  it('extracts all 15 check-ins on the page', () => {
    expect(out.checkins).toHaveLength(15);
  });

  it('parses the first check-in fully', () => {
    expect(out.checkins[0]).toEqual({
      checkin_id: '1578245453',
      bid: 6421621,
      beer_name: 'Emberwood',
      brewery_name: 'Põhjala',
      user_rating: 4.5,
      checkin_at: 'Mon, 15 Jun 2026 19:25:26 +0000',
      venue: 'Os. Górczewska 200',
      author: 'ysilvestrov',
    });
  });

  it('every check-in has a numeric id, a bid, and a non-empty beer + brewery name', () => {
    for (const c of out.checkins) {
      expect(c.checkin_id).toMatch(/^\d+$/);
      expect(Number.isInteger(c.bid)).toBe(true);
      expect(c.beer_name.length).toBeGreaterThan(0);
      expect(c.brewery_name.length).toBeGreaterThan(0);
      expect(typeof c.checkin_at).toBe('string');
      expect(c.checkin_at.length).toBeGreaterThan(0);
    }
  });

  it('captures personal ratings and venues where present', () => {
    expect(out.checkins.some((c) => c.user_rating !== null)).toBe(true);
    expect(out.checkins.some((c) => c.venue !== null)).toBe(true);
  });

  it('reports the profile total check-ins', () => {
    expect(out.profileTotal).toBe(12407);
  });

  it('nextMaxId is the last (oldest) check-in id on the page', () => {
    expect(out.nextMaxId).toBe(out.checkins[out.checkins.length - 1].checkin_id);
    expect(out.nextMaxId).toMatch(/^\d+$/);
  });

  it('paginates a more_feed fragment (no .stats / no .more_checkins button)', () => {
    // After page 1, pages come from /profile/more_feed/<user>/<offset> as raw item
    // fragments with no stats block and no Show More button. nextMaxId must still be
    // the oldest id so the walk can continue; profileTotal is unknown in a fragment.
    const fragment = `
      <div class="item " data-checkin-id="1577233492">
        <p class="text">
          <a class="user" href="/user/ysilvestrov">Y</a> is drinking
          <a href="/b/oatkeeper/6438923">Oatkeeper</a> by
          <a href="/PiwnePodziemie">Piwne Podziemie</a> at
          <a href="/v/offside/1">Offside</a>
        </p>
        <div class="caps " data-rating="3.5"></div>
        <a class="time">Fri, 12 Jun 2026 17:47:48 +0000</a>
      </div>
      <div class="item " data-checkin-id="1574693054">
        <p class="text">
          <a class="user" href="/user/ysilvestrov">Y</a> is drinking
          <a href="/b/renety-2024/6391450">Renety 2024</a> by
          <a href="/SlowFlow">Slow Flow Group</a>
        </p>
        <a class="time">Sun, 31 May 2026 18:03:24 +0000</a>
      </div>`;
    const frag = parseCheckinFeedPage(fragment);
    expect(frag.checkins).toHaveLength(2);
    expect(frag.profileTotal).toBeNull();
    expect(frag.nextMaxId).toBe('1574693054'); // oldest (last) id, despite no button
  });

  it('returns empty + null cursor for a page with no check-ins', () => {
    const empty = parseCheckinFeedPage('<html><body></body></html>');
    expect(empty.checkins).toEqual([]);
    expect(empty.nextMaxId).toBeNull();
    expect(empty.profileTotal).toBeNull();
  });

  it('skips a malformed item missing a checkin id or bid', () => {
    const broken = '<div class="item" data-checkin-id="9"><p class="text"><a href="/x">no bid</a></p></div>';
    expect(parseCheckinFeedPage(broken).checkins).toEqual([]);
  });

  it('yields user_rating: null when no .caps[data-rating] is present', () => {
    // All 15 fixture check-ins have ratings, so exercise the null path with inline HTML.
    const unrated = `
      <div class="item" data-checkin-id="9999">
        <p class="text">
          <a class="user" href="/user/someone">Someone</a> is drinking
          <a href="/b/some-beer/5">Some Beer</a> by
          <a href="/Brewery">Some Brewery</a>
        </p>
        <a class="time">Sun, 01 Jan 2023 12:00:00 +0000</a>
      </div>`;
    const result = parseCheckinFeedPage(unrated);
    expect(result.checkins).toHaveLength(1);
    expect(result.checkins[0].user_rating).toBeNull();
  });
});
