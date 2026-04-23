import { createHttp } from './http';

test('createHttp serialises requests through the queue (concurrency 1)', async () => {
  let active = 0;
  let maxActive = 0;
  const fakeFetch: typeof fetch = async () => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 20));
    active--;
    return new Response('ok', { status: 200 });
  };
  const http = createHttp({ userAgent: 'ua', minGapMs: 10, fetchImpl: fakeFetch });
  await Promise.all([http.get('a'), http.get('b'), http.get('c')]);
  expect(maxActive).toBe(1);
});
