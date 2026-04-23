import { createGeocoder } from './geocoder';

test('geocodes an address via injected fetch', async () => {
  const fakeFetch: typeof fetch = async (url) => {
    expect(String(url)).toMatch(/nominatim/);
    return new Response(JSON.stringify([{ lat: '52.23', lon: '21.01' }]), { status: 200 });
  };
  const geo = createGeocoder({ userAgent: 'ua', fetchImpl: fakeFetch });
  const coords = await geo('Żurawia 32, Warszawa');
  expect(coords).toEqual({ lat: 52.23, lon: 21.01 });
});

test('returns null on empty result', async () => {
  const fakeFetch: typeof fetch = async () => new Response('[]', { status: 200 });
  const geo = createGeocoder({ userAgent: 'ua', fetchImpl: fakeFetch });
  expect(await geo('nowhere')).toBeNull();
});
