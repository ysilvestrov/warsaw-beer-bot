import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHttp } from './http';
import { createRotatingDispatcher } from './proxy-rotator';

// #581: увесь сенс цього файлу в тому, чого нема в решті тестів — тут НЕ підміняється
// `fetchImpl`. Виконується справжній `fetch` зі справжнім `ProxyAgent`, тобто рівно та пара,
// яку бамп undici ^7→^8 і розсинхронізував. Усе на 127.0.0.1: ні Webshare, ні мережі назовні.

interface Origin { url: string; close(): Promise<void>; }

async function startOrigin(body: string): Promise<Origin> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(body);
  });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', () => r()); });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((r) => { server.close(() => r()); }),
  };
}

interface Proxy { url: string; seen(): number; close(): Promise<void>; }

/** Мінімальний forward-проксі: absolute-URI GET, як його шле ProxyAgent для http-цілей. */
async function startProxy(): Promise<Proxy> {
  let seen = 0;
  const server = http.createServer((req, res) => {
    seen += 1;
    const target = new URL(req.url as string);
    const up = http.request(
      { host: target.hostname, port: target.port, path: target.pathname, method: req.method },
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

test('createHttp reaches the origin THROUGH the proxy with no fetch stand-in', async () => {
  const origin = await startOrigin('HELLO-ORIGIN');
  const proxy = await startProxy();
  const rotator = createRotatingDispatcher({ proxyUrl: proxy.url, mode: 'per-request' });
  try {
    const client = createHttp({ userAgent: 'wbb-proxy-test', minGapMs: 0, rotator });
    const body = await client.get(origin.url);
    expect(body).toBe('HELLO-ORIGIN');
    // Друге твердження несе не менше за перше: без нього тест був би однаково зеленим,
    // якби запит пішов ПОВЗ проксі напряму в origin.
    expect(proxy.seen()).toBe(1);
  } finally {
    rotator.close();
    await origin.close();
    await proxy.close();
  }
});
