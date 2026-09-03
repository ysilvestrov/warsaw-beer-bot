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
