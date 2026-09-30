import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMcpCheckins } from './mcp-checkins';

// A live get_my_friend_feed answer (2026-09-30), cut to three records; friends' names anonymized.
const BODY = readFileSync(join(__dirname, '__fixtures__/mcp-friend-feed.json'), 'utf8');
const asTool = (text: string, isError = false) => ({ isError, content: [{ type: 'text', text }] });

describe('parseMcpCheckins', () => {
  it('reads every field the festival needs from a live answer; 0 rating is "no rating", venue [] is none', () => {
    expect(parseMcpCheckins(asTool(BODY))).toEqual({
      count: 3,
      items: [
        { checkinId: 1605095696, checkinAt: '2026-09-30T17:04:06.000Z', bid: 6813263, beerName: 'Absztyfikant', breweryName: 'Ziemia Obiecana', style: 'IPA - Session', abv: 5.8, venueId: 10600165, userName: 'friend_1', rating: 3.75 },
        { checkinId: 1605095315, checkinAt: '2026-09-30T17:02:21.000Z', bid: 6753545, beerName: 'INDIGO BLOOM', breweryName: 'Paradox', style: 'Sour - Fruited', abv: 4.5, venueId: 12613920, userName: 'friend_2', rating: null },
        { checkinId: 1605095205, checkinAt: '2026-09-30T17:01:45.000Z', bid: 6837562, beerName: 'The Night Before, The Morning After', breweryName: 'Zagovor Brewery', style: 'IPA - American', abv: 6.5, venueId: null, userName: 'friend_3', rating: null },
      ],
    });
  });

  it('drops a record without a bid or with a time lacking seconds, and counts what Untappd sent', () => {
    const body = JSON.parse(BODY);
    delete body.checkins.items[0].beer.bid;
    body.checkins.items[1].created_at = '30 Sep 26';
    const page = parseMcpCheckins(asTool(JSON.stringify(body)));
    expect(page).toEqual({ count: 3, items: [expect.objectContaining({ checkinId: 1605095205 })] });
  });

  it('a tool error carries its text; a body that is not the Untappd shape is bad_shape', () => {
    expect([
      parseMcpCheckins(asTool('UNTAPPD_NOT_CONNECTED', true)),
      parseMcpCheckins(asTool('not json')),
      parseMcpCheckins(asTool('{"response":{}}')),
      parseMcpCheckins({ content: [] }),
    ]).toEqual([{ error: 'UNTAPPD_NOT_CONNECTED' }, { error: 'bad_shape' }, { error: 'bad_shape' }, { error: 'bad_shape' }]);
  });
});
