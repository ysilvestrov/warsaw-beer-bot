import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProxyAgent } from 'undici';
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

// Сертифікат генерується тут, а не комітиться: приватний ключ у репо — це вічна сирена
// секрет-сканера, а сертифікат із датою — тест, який одного дня почне падати сам по собі.
// Перевірка сертифіката в клієнті все одно вимкнена, тож його термін ролі не грає.
function selfSignedCert(): { key: string; cert: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'wbb-proxy-tls-'));
  const keyPath = join(dir, 'k.pem');
  const certPath = join(dir, 'c.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost',
  ], { stdio: 'ignore' });
  return { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8'), dir };
}

async function startTlsOrigin(body: string): Promise<Origin> {
  const { key, cert, dir } = selfSignedCert();
  const server = https.createServer({ key, cert }, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(body);
  });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', () => r()); });
  const { port } = server.address() as AddressInfo;
  return {
    url: `https://127.0.0.1:${port}/`,
    // Закриття origin забирає з собою і теку з приватним ключем — інакше вона
    // лишається в tmpdir() після кожного прогону і накопичується без кінця.
    // Безумовно: спрацьовує з того самого finally, що й при впалому тесті.
    close: () => new Promise<void>((r) => {
      server.close(() => {
        rmSync(dir, { recursive: true, force: true });
        r();
      });
    }),
  };
}

/** Проксі, що вміє CONNECT — саме той шлях, яким ходить реальний https-трафік. */
async function startConnectProxy(): Promise<Proxy> {
  let seen = 0;
  const server = http.createServer();
  server.on('connect', (req, clientSocket, head) => {
    seen += 1;
    const [host, port] = (req.url as string).split(':');
    const up = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(clientSocket);
      clientSocket.pipe(up);
    });
    up.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => up.destroy());
  });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', () => r()); });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen: () => seen,
    close: () => new Promise<void>((r) => { server.close(() => r()); }),
  };
}

test('createHttp tunnels https through the proxy with CONNECT', async () => {
  const origin = await startTlsOrigin('HELLO-TLS');
  const proxy = await startConnectProxy();
  const rotator = createRotatingDispatcher({
    proxyUrl: proxy.url,
    mode: 'per-request',
    // Клас ProxyAgent і `fetch` тут справжні; послаблена ЛИШЕ перевірка сертифіката,
    // бо origin самопідписаний. Шов `agentFactory` уже існує в проді (#222).
    agentFactory: (url) => new ProxyAgent({ uri: url, requestTls: { rejectUnauthorized: false } }),
  });
  try {
    const client = createHttp({ userAgent: 'wbb-proxy-test', minGapMs: 0, rotator });
    expect(await client.get(origin.url)).toBe('HELLO-TLS');
    expect(proxy.seen()).toBe(1);
  } finally {
    rotator.close();
    await origin.close();
    await proxy.close();
  }
});
