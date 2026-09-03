import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAlgoliaSearch } from './algolia';

// #581: як і `http.proxy.test.ts` — без підміни `fetchImpl`, справжній `fetch` і справжній
// `ProxyAgent`, усе на 127.0.0.1.
//
// Проксований шлях проходимо ЧЕРЕЗ ПУБЛІЧНИЙ `search()`, не через тестовий метод: `withRecovery`
// пробує напряму, і лише на 401/403 (і за відсутності `refreshKeys`) падає на проксі. Тому
// origin віддає 403 на перший запит і 200 на другий — порядок детермінований. Так тест міряє
// саме той шлях, яким ходить прод, а не спеціально прокладену для нього стежку.

async function startAlgoliaOrigin(): Promise<{ base: string; hits(): number; close(): Promise<void> }> {
  let hits = 0;
  const server = http.createServer((_req, res) => {
    hits += 1;
    if (hits === 1) { res.writeHead(403); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    // Поля мають називатись так, як їх читає `parseAlgoliaResponse`: ключ — `bid`, НЕ `objectID`.
    res.end(JSON.stringify({
      hits: [{
        bid: 4242,
        beer_name: 'Local Lager',
        brewery_name: 'Loopback Brew',
        type_name: 'Lager',
        beer_abv: 5,
        rating_score: 3.7,
      }],
    }));
  });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', () => r()); });
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    hits: () => hits,
    close: () => new Promise<void>((r) => { server.close(() => r()); }),
  };
}

async function startProxy(): Promise<{ url: string; seen(): number; close(): Promise<void> }> {
  let seen = 0;
  const server = http.createServer((req, res) => {
    seen += 1;
    const target = new URL(req.url as string);
    const up = http.request(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: req.method,
        headers: req.headers,
      },
      (ur) => { res.writeHead(ur.statusCode ?? 502, ur.headers); ur.pipe(res); },
    );
    up.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', () => r()); });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen: () => seen,
    close: () => new Promise<void>((r) => { server.close(() => r()); }),
  };
}

test('algolia falls back THROUGH the proxy on a block, with no fetch stand-in', async () => {
  const origin = await startAlgoliaOrigin();
  const proxy = await startProxy();
  try {
    const search = createAlgoliaSearch({
      appId: 'TESTAPPID',
      searchKey: 'testsearchkey',
      proxyUrl: proxy.url,
      endpointBase: origin.base,
      minGapMs: 0,
    });
    const results = await search.search('local lager');
    expect(results.map((r) => r.bid)).toEqual([4242]);
    // origin бачив два запити: прямий (403) і проксований (200).
    expect(origin.hits()).toBe(2);
    // а проксі — рівно один: без цього твердження тест був би зеленим і тоді,
    // якби друга спроба пішла повз проксі.
    expect(proxy.seen()).toBe(1);
  } finally {
    await origin.close();
    await proxy.close();
  }
});
