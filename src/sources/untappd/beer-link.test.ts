import { beerLinkOf, resolveShortLink } from './beer-link';

describe('beerLinkOf', () => {
  it('reads the bid from a full beer link, with or without www and a trailing query', () => {
    expect([
      beerLinkOf('https://untappd.com/b/magic-road-carotenes/7230846'),
      beerLinkOf(' https://www.untappd.com/b/pinta-hop-selection-motueka/6134008?ref=share '),
    ]).toEqual([{ bid: 7230846 }, { bid: 6134008 }]);
  });

  it('keeps a short untp.beer link to be resolved', () => {
    expect(beerLinkOf('https://untp.beer/q5a8n')).toEqual({ short: 'https://untp.beer/q5a8n' });
  });

  it('refuses what is not an https beer link on those two hosts', () => {
    expect([
      beerLinkOf('http://untappd.com/b/x/1'),
      beerLinkOf('https://untappd.com.evil.example/b/x/1'),
      beerLinkOf('https://untappd.com/c/1605095696'),
      beerLinkOf('https://untappd.com/v/legia/11142155'),
      beerLinkOf('https://untappd.com/b/x/0'),
      beerLinkOf('http://untp.beer/q5a8n'),
      beerLinkOf('https://untp.beer/q5a8n/more'),
      beerLinkOf('https://untp.beer/abcdefghijklmnopq'),
      beerLinkOf('motueka'),
      beerLinkOf(''),
    ]).toEqual([null, null, null, null, null, null, null, null, null, null]);
  });
});

const answer = (status: number, location?: string) => (async () =>
  new Response(null, { status, headers: location ? { location } : {} })) as unknown as typeof fetch;

describe('resolveShortLink', () => {
  it('takes the bid from the Location of the redirect and does not follow it', async () => {
    const calls: unknown[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push([url, init.redirect]);
      return new Response(null, { status: 302, headers: { location: 'https://untappd.com/b/magic-road-carotenes/7230846' } });
    }) as unknown as typeof fetch;
    expect([await resolveShortLink('https://untp.beer/q5a8n', fetchFn), calls]).toEqual([
      7230846, [['https://untp.beer/q5a8n', 'manual']],
    ]);
  });

  it('is null for a redirect elsewhere, a page instead of a redirect, or a failed request', async () => {
    const thrown = (async () => { throw new Error('ENOTFOUND'); }) as unknown as typeof fetch;
    expect([
      await resolveShortLink('https://untp.beer/a', answer(302, 'https://untappd.com/v/legia/11142155')),
      await resolveShortLink('https://untp.beer/a', answer(302)),
      await resolveShortLink('https://untp.beer/a', answer(200)),
      await resolveShortLink('https://untp.beer/a', thrown),
    ]).toEqual([null, null, null, null]);
  });
});
