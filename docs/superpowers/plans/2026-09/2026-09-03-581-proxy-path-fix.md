# #581 — проксований шлях Untappd: план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** повернути до життя кожен запит, що йде через Webshare-проксі (мертвий із 2026-08-20), і покрити цей шлях тестами, які виконують справжній `fetch` зі справжнім `ProxyAgent`, а не фейк.

**Architecture:** глобальний `fetch` у Node 24 — це **вбудована** копія undici, а `dispatcher`, який ми йому даємо, — з **npm-пакета** undici v8; контракти хендлера різні. Обидва модулі, що віддають `dispatcher` (`src/sources/http.ts`, `src/sources/untappd/algolia.ts`), переходять на `fetch` із пакета. Шов `fetchImpl` при цьому звужується до того, що ці модулі справді вживають, бо `undici.fetch` не присвоюється до `typeof fetch`.

**Tech Stack:** Node 24, TypeScript (strict, nodenext), undici `^8.10.0`, Vitest, `node:http`/`node:https`/`node:net` для локальних серверів у тестах, `openssl` для сертифіката.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-03-581-582-proxy-path-and-job-health-design.md`

## Global Constraints

- **Гейт після КОЖНОЇ задачі — повний, не точковий:** `npm test` (усі 168 файлів) **і** `npm run typecheck` (він проганяє і `tsconfig.json`, і `tsconfig.scripts.json`). Точковий прогін одного файлу не рахується за гейт.
- **Жодних кастів у шві.** `as unknown as typeof fetch` заборонено: він ховає рівно те неспівпадіння типів, яке ця робота лагодить. Якщо тип не сходиться — правити тип, не глушити компілятор.
- **Тести в CI не ходять у зовнішню мережу.** Усе, крім Task 5, працює на `127.0.0.1`. Task 5 гейтований змінними оточення, яких у CI нема.
- **Ніяких секретів у репо.** Сертифікат для TLS-тесту генерується на старті тесту, приватний ключ не комітиться.
- **Змінні `UNTAPPD_PROXY_SMOKE` і `WEBSHARE_PROXY` у Task 5 читаються прямо з `process.env`**, повз `loadEnv` (`src/config/env.ts`): це тестовий шов, і в схемі конфігу бота йому не місце.
- **Не чіпати** інших клієнтів (`geocoder`, `websearch/resolver`, `infra/github-issues`, `infra/triage-llm`, `sources/cws-version`, `domain/router`): вони проксі не бачать і лишаються на глобальному `fetch`.
- Коментарі в коді — українською, як у решті репо; ідентифікатори — англійською.

---

### Task 1: звужений шов, `http.ts` на undici, і тест, що справді йде крізь проксі

**Files:**
- Create: `src/sources/fetch-like.ts`
- Create: `src/sources/http.proxy.test.ts`
- Modify: `src/sources/http.ts` (імпорти, `HttpOpts.fetchImpl`, `createHttp`, `doFetch`, `classify`)

**Interfaces:**
- Consumes: `createRotatingDispatcher` з `src/sources/proxy-rotator.ts` — `({ proxyUrl: string, mode: 'per-request' | 'on-block', onRotate?, agentFactory? }) => RotatingDispatcher`.
- Produces: `FetchLike`, `FetchInitLike`, `FetchResponseLike` з `src/sources/fetch-like.ts`; `startOrigin()` / `startProxy()` з `src/sources/http.proxy.test.ts` (Task 3 розширює той самий файл).

- [ ] **Step 1: Write the failing test**

Створити `src/sources/http.proxy.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/sources/http.proxy.test.ts`

Expected: FAIL. Помилка — `TypeError: fetch failed`, причина в ланцюжку `cause`: `InvalidArgumentError: invalid onRequestStart method`. Це та сама помилка, що в проді.

Якщо тест **пройшов** — зупинитись і розібратись: значить, `createHttp` уже не віддає `dispatcher` глобальному `fetch`, і передумова задачі неправдива.

- [ ] **Step 3: Create the narrow seam**

Створити `src/sources/fetch-like.ts`:

```ts
import type { Dispatcher } from 'undici';

// #581: глобальний `fetch` у Node 24 — це ВБУДОВАНА копія undici, а `dispatcher`, який ми йому
// даємо, — з npm-пакета undici v8. Контракти хендлера в двох копіях різні, тож npm-івський
// `assertRequestHandler` відкидає хендлер, побудований внутрішньою:
// `InvalidArgumentError: invalid onRequestStart method`. Лікується тим, що модуль, який віддає
// `dispatcher`, бере `fetch` з ТОГО САМОГО пакета.
//
// Шов звужено до того, що `http.ts` і `algolia.ts` справді вживають (`ok`, `status`, `text`,
// `json`), бо `undici.fetch` НЕ присвоюється до `typeof fetch` — типи розходяться на
// `Request.duplex`/`textStream`. Каст був би одним рядком, але сховав би саме те неспівпадіння,
// яке ця робота й лагодить, і наступний такий баг знову став би невидимим для компілятора.

export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface FetchInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  redirect?: RequestRedirect;
  dispatcher?: Dispatcher;
}

export type FetchLike = (url: string, init?: FetchInitLike) => Promise<FetchResponseLike>;
```

- [ ] **Step 4: Move `http.ts` onto the seam**

У `src/sources/http.ts`:

1. Додати імпорти поруч із наявними:

```ts
import { fetch as undiciFetch } from 'undici';
import type { FetchInitLike, FetchLike, FetchResponseLike } from './fetch-like';
```

2. В `HttpOpts` замінити рядок `fetchImpl?: typeof fetch;` на:

```ts
  fetchImpl?: FetchLike;
```

3. У `createHttp` замінити `const f = opts.fetchImpl ?? fetch;` на:

```ts
  // #581: саме тут була поломка — глобальний `fetch` не приймає `dispatcher` з npm-undici.
  const f = opts.fetchImpl ?? undiciFetch;
```

4. Замінити тіло `doFetch` (типи в сигнатурі й в `fetchOpts`):

```ts
  async function doFetch(url: string): Promise<FetchResponseLike> {
    const headers: Record<string, string> = { 'User-Agent': opts.userAgent };
    if (opts.cookie) headers['Cookie'] = `untappd_user_v3_e=${opts.cookie}`;
    const fetchOpts: FetchInitLike = { headers };
    if (opts.redirect) fetchOpts.redirect = opts.redirect;
    const dispatcher = opts.rotator?.current();
    if (dispatcher) fetchOpts.dispatcher = dispatcher;
    const res = await f(url, fetchOpts);
    lastAt = Date.now();
    return res;
  }
```

5. У сигнатурі `classify` замінити `res: Response` на `res: FetchResponseLike`:

```ts
  async function classify(url: string, res: FetchResponseLike): Promise<Outcome> {
```

Тіло `classify` не змінюється: воно вживає лише `res.status`, `res.ok` і `res.text()`.

- [ ] **Step 5: Run the proxy test to verify it passes**

Run: `npx vitest run src/sources/http.proxy.test.ts`
Expected: PASS, обидва твердження.

- [ ] **Step 6: Mutation-prove the test is not decorative**

Тимчасово повернути в `createHttp` глобальний `fetch`: `const f = opts.fetchImpl ?? fetch;`

Run: `npx vitest run src/sources/http.proxy.test.ts`
Expected: FAIL з `InvalidArgumentError: invalid onRequestStart method`.

Потім повернути `undiciFetch` і переконатись, що знову PASS. **Не комітити мутацію.**

- [ ] **Step 7: Run the FULL gate**

Run: `npm test && npm run typecheck`

Expected: усі тести зелені (наявні фейки, типізовані як `typeof fetch`, присвоюються до `FetchLike` — перевірено компілятором), typecheck чистий.

Якщо якийсь наявний тест у `src/sources/http.test.ts` перестав компілюватись — **не** послаблювати тип у `fetch-like.ts` кастом; звузити фейк у тесті до того, що він справді повертає.

- [ ] **Step 8: Commit**

```bash
git add src/sources/fetch-like.ts src/sources/http.ts src/sources/http.proxy.test.ts
git commit -m "fix(#581): createHttp бере fetch з undici, і тест іде крізь справжній проксі"
```

---

### Task 2: `algolia.ts` на той самий шов, з ін'єктованим ендпойнтом і живим тестом

**Files:**
- Modify: `src/sources/untappd/algolia.ts` (імпорти, `AlgoliaSearchOpts`, `createAlgoliaSearch`, `endpoint`, `rawSearch`, `rawHydrate`)
- Create: `src/sources/untappd/algolia.proxy.test.ts`

**Interfaces:**
- Consumes: `FetchLike`/`FetchInitLike` із Task 1 (`src/sources/fetch-like.ts`).
- Produces: `AlgoliaSearchOpts.endpointBase?: string`.

**Чому ін'єктований ендпойнт.** Спека стверджувала, що харнес із Task 1 «накриває і `algolia`». Це неправда: `endpoint()` будує URL з `appId` (`https://<appId>-dsn.algolia.net/...`), тож локальний origin туди не підставити, і без цього шва проксований шлях `algolia` офлайн не перевіряється взагалі. Значення за замовчуванням поведінку проду не змінює.

- [ ] **Step 1: Write the failing test**

Створити `src/sources/untappd/algolia.proxy.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/sources/untappd/algolia.proxy.test.ts`

Expected: FAIL. Спочатку — на невідомій опції `endpointBase` (помилка типів), а коли опцію додано на Step 3 — з `TypeError: fetch failed` / `InvalidArgumentError: invalid onRequestStart method` на проксованій спробі.

Якщо тест падає з `expect(origin.hits()).toBe(2)` і значенням `1` — це означає, що `withRecovery` не дійшов до проксі; звірити, що `refreshKeys` у тесті **не** передається і що origin віддає саме `403`.

- [ ] **Step 3: Implement**

У `src/sources/untappd/algolia.ts`:

1. Додати до імпортів:

```ts
import { fetch as undiciFetch } from 'undici';
import type { FetchInitLike, FetchLike } from '../fetch-like';
```

2. В `AlgoliaSearchOpts` замінити `fetchImpl?: typeof fetch;` на `fetchImpl?: FetchLike;` і додати:

```ts
  /** #581: база ендпойнта. Дефолт — реальний Algolia; підмінюється лише тестом, щоб
   *  проксований шлях можна було перевірити на 127.0.0.1, без зовнішньої мережі. */
  endpointBase?: string;
```

3. Замінити модульну функцію `endpoint`:

```ts
function endpoint(appId: string, base?: string): string {
  return `${base ?? `https://${appId}-dsn.algolia.net`}/1/indexes/beer/query`;
}
```

4. У `createAlgoliaSearch` замінити `const f = opts.fetchImpl ?? fetch;` на:

```ts
  // #581: глобальний `fetch` не приймає `dispatcher` з npm-undici.
  const f = opts.fetchImpl ?? undiciFetch;
```

5. У `rawSearch`: тип `init` змінити на `FetchInitLike`, а обидва виклики `endpoint(keys.appId)` — на `endpoint(keys.appId, opts.endpointBase)`.

6. У `rawHydrate`: тип `init` змінити на `FetchInitLike`, а рядок

```ts
    const url = `https://${keys.appId}-dsn.algolia.net/1/indexes/*/objects`;
```

замінити на

```ts
    const base = opts.endpointBase ?? `https://${keys.appId}-dsn.algolia.net`;
    const url = `${base}/1/indexes/*/objects`;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/sources/untappd/algolia.proxy.test.ts`
Expected: PASS, обидва твердження.

- [ ] **Step 5: Mutation-prove**

Тимчасово повернути `const f = opts.fetchImpl ?? fetch;`.
Run: `npx vitest run src/sources/untappd/algolia.proxy.test.ts` → Expected: FAIL з `InvalidArgumentError`.
Повернути `undiciFetch`, переконатись, що PASS. **Не комітити мутацію.**

- [ ] **Step 6: Run the FULL gate**

Run: `npm test && npm run typecheck`
Expected: усе зелене. Особливо звірити `src/sources/untappd/algolia.test.ts` — його фейки мають і далі компілюватись.

- [ ] **Step 7: Commit**

```bash
git add src/sources/untappd/algolia.ts src/sources/untappd/algolia.proxy.test.ts
git commit -m "fix(#581): algolia бере fetch з undici, ендпойнт ін'єктується заради живого тесту"
```

---

### Task 3: CONNECT-тунель у тому самому харнесі

**Files:**
- Modify: `src/sources/http.proxy.test.ts` (додати другий тест і два хелпери)

**Interfaces:**
- Consumes: `startProxy`/`startOrigin` із Task 1; `createRotatingDispatcher` з опцією `agentFactory`.
- Produces: нічого для наступних задач.

**Чому це в CI, а не лише в Task 5.** Spike довів, що CONNECT відтворюється локально. Без цього тесту зелений CI не покривав би саме той шматок `ProxyAgent`, який відрізняє https від http, — і бамп, що зламав би лише тунель, знову проїхав би зеленим.

- [ ] **Step 1: Write the failing test**

Дописати в `src/sources/http.proxy.test.ts`:

```ts
import https from 'node:https';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProxyAgent } from 'undici';

// Сертифікат генерується тут, а не комітиться: приватний ключ у репо — це вічна сирена
// секрет-сканера, а сертифікат із датою — тест, який одного дня почне падати сам по собі.
// Перевірка сертифіката в клієнті все одно вимкнена, тож його термін ролі не грає.
function selfSignedCert(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), 'wbb-proxy-tls-'));
  const keyPath = join(dir, 'k.pem');
  const certPath = join(dir, 'c.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost',
  ], { stdio: 'ignore' });
  return { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8') };
}

async function startTlsOrigin(body: string): Promise<Origin> {
  const { key, cert } = selfSignedCert();
  const server = https.createServer({ key, cert }, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(body);
  });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', () => r()); });
  const { port } = server.address() as AddressInfo;
  return {
    url: `https://127.0.0.1:${port}/`,
    close: () => new Promise<void>((r) => { server.close(() => r()); }),
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
```

- [ ] **Step 2: Run it to verify it passes on the fixed code**

Run: `npx vitest run src/sources/http.proxy.test.ts`
Expected: PASS (Task 1 уже полагодив `createHttp`; цей тест розширює покриття на тунель).

- [ ] **Step 3: Mutation-prove the CONNECT test specifically**

Тимчасово повернути в `createHttp` глобальний `fetch`.
Run: `npx vitest run src/sources/http.proxy.test.ts`
Expected: FAIL **обидва** тести — і http, і CONNECT — з `InvalidArgumentError`.
Повернути `undiciFetch`. **Не комітити мутацію.**

- [ ] **Step 4: Prove the tunnel assertion is load-bearing**

Тимчасово прибрати `agentFactory` з `createRotatingDispatcher` у CONNECT-тесті.
Expected: FAIL на перевірці сертифіката (`self-signed certificate`), а не мовчазний зелений.
Повернути `agentFactory`.

- [ ] **Step 5: Run the FULL gate**

Run: `npm test && npm run typecheck`
Expected: усе зелене.

- [ ] **Step 6: Commit**

```bash
git add src/sources/http.proxy.test.ts
git commit -m "test(#581): CONNECT-тунель через локальний проксі — CI більше не сліпий до https"
```

---

### Task 4: source-guard — нове місце виклику не проїде мовчки

**Files:**
- Create: `src/sources/fetch-dispatcher-guard.test.ts`

**Interfaces:**
- Consumes: нічого. Читає дерево `src/` з диска.
- Produces: нічого.

**Що саме він стереже.** Тести з Task 1–3 ловлять регресію в `createHttp` і `createAlgoliaSearch`. Вони нічого не знають про **третій** модуль, який хтось завтра навчить віддавати `dispatcher`. Правило текстове й навмисно тупе: файл у `src/`, що згадує і `dispatcher`, і `fetch`, зобов'язаний імпортувати `fetch` з `undici`. На момент написання `src/sources/proxy-rotator.ts` згадує `dispatcher`, але слова `fetch` не містить жодного разу — тому окремого списку винятків не потрібно, і його не треба заводити.

- [ ] **Step 1: Write the test**

Створити `src/sources/fetch-dispatcher-guard.test.ts`:

```ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

const SRC = resolve(__dirname, '..');

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { out.push(...tsFiles(p)); continue; }
    if (!name.endsWith('.ts')) continue;
    if (name.endsWith('.test.ts')) continue;
    out.push(p);
  }
  return out;
}

// #581: цей guard існує тому, що інтеграційні тести знають лише ті два модулі, які вже
// віддають `dispatcher`. Третій, доданий завтра, віддав би його глобальному `fetch` і проїхав
// би зеленим — рівно так, як проїхав бамп undici ^7→^8, що поклав чотири шляхи на 14 діб.
test('every module that gives fetch a dispatcher takes fetch from undici', () => {
  const offenders: string[] = [];
  for (const file of tsFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('dispatcher')) continue;
    if (!text.includes('fetch')) continue;
    const importsUndiciFetch = /import\s*\{[^}]*\bfetch\b[^}]*\}\s*from\s*'undici'/.test(text);
    if (!importsUndiciFetch) offenders.push(relative(SRC, file));
  }
  expect(offenders).toEqual([]);
});
```

- [ ] **Step 2: Run it to verify it passes**

Run: `npx vitest run src/sources/fetch-dispatcher-guard.test.ts`
Expected: PASS (після Task 1 і 2 обидва модулі імпортують `fetch` з `undici`).

- [ ] **Step 3: Mutation-prove the guard actually guards**

Тимчасово створити `src/sources/__offender.ts` із вмістом:

```ts
export async function bad(d: unknown): Promise<void> {
  await fetch('https://example.invalid', { dispatcher: d } as RequestInit);
}
```

Run: `npx vitest run src/sources/fetch-dispatcher-guard.test.ts`
Expected: FAIL, і в списку `offenders` має бути `__offender.ts`.

Видалити `src/sources/__offender.ts` і переконатись, що знову PASS. **Файл-порушник не комітити.**

- [ ] **Step 4: Run the FULL gate**

Run: `npm test && npm run typecheck`
Expected: усе зелене.

- [ ] **Step 5: Commit**

```bash
git add src/sources/fetch-dispatcher-guard.test.ts
git commit -m "test(#581): guard — модуль із dispatcher зобов'язаний брати fetch з undici"
```

---

### Task 5: smoke крізь справжній Webshare, під env-прапорцем

**Files:**
- Create: `src/sources/http.webshare-smoke.test.ts`
- Modify: `docs/` — див. Step 4

**Interfaces:**
- Consumes: `createHttp`, `createRotatingDispatcher`.
- Produces: нічого.

**Що він доводить, чого не доводять Task 1–3.** Ті три перевіряють **наш код**. Цей — що **реальний Webshare** відповідає: креденшли живі, ендпойнт на місці, вихідний IP працює. Це питання експлуатації, тому він гейтований і в CI не запускається ніколи.

- [ ] **Step 1: Write the test**

Створити `src/sources/http.webshare-smoke.test.ts`:

```ts
import { createHttp } from './http';
import { createRotatingDispatcher } from './proxy-rotator';

// #581: єдиний тест у репо, що виходить у зовнішню мережу і палить платний проксі-трафік.
// Тому він гейтований двома змінними і в CI не запускається ніколи. Змінні читаються прямо з
// `process.env`, повз `loadEnv`: це тестовий шов, і в схемі конфігу бота йому не місце.
const PROXY = process.env.WEBSHARE_PROXY;
const ENABLED = process.env.UNTAPPD_PROXY_SMOKE === '1' && !!PROXY;

// Назва навмисно каже, коли він працює: пропущений тест не має читатись як успішний.
test.skipIf(!ENABLED)(
  'live Webshare smoke (set UNTAPPD_PROXY_SMOKE=1 and WEBSHARE_PROXY to run): https tunnels through the paid proxy',
  async () => {
    const rotator = createRotatingDispatcher({ proxyUrl: PROXY as string, mode: 'per-request' });
    try {
      const client = createHttp({ userAgent: 'wbb-webshare-smoke', minGapMs: 0, rotator });
      const body = await client.get('https://api.ipify.org?format=json');
      // Що саме нас цікавить: відповідь прийшла і вона з тунелю, а не з нашого IP.
      expect(JSON.parse(body)).toHaveProperty('ip');
    } finally {
      rotator.close();
    }
  },
  30_000,
);
```

- [ ] **Step 2: Verify it is SKIPPED by default**

Run: `npx vitest run src/sources/http.webshare-smoke.test.ts`
Expected: 1 skipped, 0 failed. У виводі має бути видно назву з підказкою, як його ввімкнути.

- [ ] **Step 3: Run it for real, once**

Прочитати `WEBSHARE_PROXY` із прод-конфігу і запустити:

```bash
WEBSHARE_PROXY="$(sudo -u warsaw-beer-bot bash -lc 'grep ^WEBSHARE_PROXY= /etc/warsaw-beer-bot/.env | cut -d= -f2-')" \
UNTAPPD_PROXY_SMOKE=1 npx vitest run src/sources/http.webshare-smoke.test.ts
```

Expected: PASS. Якщо FAIL — це **не** привід правити тест: це означає, що з реальним Webshare щось не так, і це треба з'ясувати до мерджу. Записати результат (пройшов / не пройшов і чому) в опис PR.

- [ ] **Step 4: Document the flag**

У `spec.md`, у розділі про Webshare-проксі, додати один рядок: що існує гейтований smoke-тест, як він називається і якими двома змінними вмикається. Не описувати його реалізацію — лише те, як ним скористатись.

- [ ] **Step 5: Run the FULL gate**

Run: `npm test && npm run typecheck`
Expected: усе зелене, smoke — skipped.

- [ ] **Step 6: Commit**

```bash
git add src/sources/http.webshare-smoke.test.ts spec.md
git commit -m "test(#581): гейтований smoke крізь справжній Webshare — CONNECT на реальних креденшлах"
```

---

## Після всіх задач

- [ ] Перевірити, чи потрібні зміни в `spec.md` понад рядок із Task 5: описати, що `createHttp` і `createAlgoliaSearch` беруть `fetch` із пакета `undici`, і **чому** (два HTTP-стеки в одному запиті — це і є дефект #581).
- [ ] Відкрити PR і **дочекатися AI-рев'ю**; перевірити кожен коментар, відсікти хибні з доказом, не з думкою.
- [ ] Не мерджити самому — доповісти «готове до мерджу».
- [ ] **Після мерджу задеплоїти і перевірити на живому проді**, що шлях справді ожив:
  - `journalctl -u warsaw-beer-bot --since "…" | grep "refresh-tap-ratings done"` — очікується `transient` менше за `processed`, а не рівно стільки ж;
  - наступного ранку `refresh-untappd done` має дати `ok > 0` (14 діб поспіль було `ok: 0` при `profiles: 5`);
  - `invalid onRequestStart` у журналі має зникнути повністю.
- [ ] Аж після цього братися за #582: канарка проксованого шляху має що перевіряти лише на полагодженому шляху.
