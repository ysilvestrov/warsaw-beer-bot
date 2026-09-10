# MCP `/match` — план обв'язки

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Зробити вже працюючий `POST /mcp` спостережуваним, задокументованим і знайденим: окремі лічильники трафіку, рядок у щоденному дайджесті, інструкція для користувача на GitHub Pages, посилання в команді `/extension` і оновлена `spec.md`.

**Architecture:** Ядро (роут, тула, домен) уже змерджене в цю гілку й не змінюється. Ця стадія додає периферію навколо нього: одну міграцію без перебудови таблиці, один аргумент `channel` в обліку, один рядок дайджесту, одну сторінку документації та один рядок у відповіді бота.

**Tech Stack:** Node.js, TypeScript (CommonJS, `module: nodenext`), Hono 4, better-sqlite3, Telegraf, Vitest.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-10-mcp-match-api-design.md`
**Стадія ядра (виконана):** `docs/superpowers/plans/2026-09/2026-09-10-mcp-match-core.md`
**Доказ живої проби (джерело формулювань у Task 3):** `docs/pr-evidence/2026-09-10-mcp-client-probe.md`

## Global Constraints

- **Стадія пишеться проти коду, який УЖЕ існує.** Правило CLAUDE.md про поділ великого плану вимагає не писати задачі проти неіснуючого механізму; тут кожна задача торкається файлів, які можна прочитати зараз. П'ять задач — це не поділ наперед, а периферія після ядра.
- **Повний гейт на КОЖНІЙ задачі:** `npm test && npm run typecheck`. Ніколи не звужений прогін як критерій завершення.
- **TDD:** тест першим, **запущений і побачений падаючим**, до реалізації. Кожен тест мутаційно доведений: прибери рядок реалізації — тест має впасти. Не падає → тест порожній, переписати.
- **Сиди з видимими значеннями**, ніколи `null`/`0` там, де тест перевіряє, чи значення взагалі використали.
- **Не чіпати ядро:** `src/api/routes/mcp.ts`, `src/api/mcp/match-tool.ts`, `src/domain/match-list.ts`, `src/domain/matcher.ts`, `src/domain/catalog-cache.ts`. Виняток — `src/api/mcp/server.ts` у Task 1, і лише щоб додати виклик обліку.
- **Не міняти жодного ліміту, статусу, назви поля виводу чи опису тули.** Вони пройшли рев'ю в стадії ядра.
- **Точні значення, скопійовані дослівно:** публічна адреса API — `https://beer-api.ysilvestrov-ai.uk`, MCP-ендпоінт — `https://beer-api.ysilvestrov-ai.uk/mcp`, сторінка інструкції — `https://ysilvestrov.github.io/warsaw-beer-bot/mcp-uk/`, ліміт `beers` — 1..200, бюджет повнокаталожного fallback — 20 на запит.
- **Комміти** українською, називають механізм. Хвіст кожного:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_017j2cAZfbxWeSVRKGtGkJS6
  ```

## Структура файлів

| Файл | Що з ним робимо |
|------|-----------------|
| `src/storage/schema.ts` (M) | міграція 30: дві колонки в `api_usage`, `ALTER TABLE ADD COLUMN` без перебудови |
| `src/storage/api_usage.ts` (M) | `channel: 'extension' \| 'mcp'`; MCP інкрементує **лише** нові колонки |
| `src/api/routes/match.ts` (M) | передає `channel: 'extension'` |
| `src/api/mcp/server.ts` (M) | додає виклик обліку з `channel: 'mcp'` у хендлер тули |
| `src/storage/stats.ts` (M) | два нові поля дайджесту |
| `src/jobs/daily-status.ts` (M) | рядок «MCP /match (вчора)» одразу під рядком розширення |
| `docs/mcp-uk.md` (C) | інструкція для користувача |
| `scripts/render-docs.ts` (M) | нова ціль рендеру → `site/mcp-uk/` |
| `.github/workflows/pages.yml` (M) | `docs/mcp-uk.md` у фільтрі `paths` |
| `site/index.html` (M) | посилання на нову сторінку |
| `src/i18n/types.ts`, `locales/{uk,en,pl}.ts` (M) | новий ключ `extension.mcp` |
| `src/bot/commands/extension.ts` (M) | третій блок у повідомленні `/extension` |
| `spec.md` (M) | `POST /mcp`, поля `/match`, §3.16, міграція 30, опис дайджесту |
| `docs/superpowers/specs/2026-09/2026-09-10-mcp-match-api-design.md` (M) | виправлення хибного речення про помилки |

---

### Task 1: Міграція 30 і `channel` в обліку

`api_usage` має рівно три лічильники, і §3.16 оголошує їх трафіком **розширення**. MCP уже працює, але його виклики зараз не рахуються ніде.

**Files:**
- Modify: `src/storage/schema.ts` (після запису `version: 29`)
- Modify: `src/storage/api_usage.ts`
- Modify: `src/api/routes/match.ts` (виклик `recordMatchUsage`)
- Modify: `src/api/mcp/server.ts` (додати виклик обліку)
- Test: `src/storage/api_usage.test.ts`, `src/api/routes/mcp.test.ts`

**Interfaces:**
- Produces: `DailyUsage` дістає `mcpRequests: number`, `mcpBeers: number`; `recordMatchUsage(db, { date, authed, beers, channel })` — Task 2 читає перші два через `getUsageForDate`.

- [ ] **Step 1: Написати падаючі тести**

У `src/storage/api_usage.test.ts` додати:

```ts
  it('an MCP call increments ONLY the MCP counters', () => {
    const db = openDb(':memory:');
    migrate(db);
    recordMatchUsage(db, { date: '2026-09-10', authed: true, beers: 7, channel: 'mcp' });

    const usage = getUsageForDate(db, '2026-09-10');
    expect(usage.mcpRequests).toBe(1);
    expect(usage.mcpBeers).toBe(7);
    // §3.16 declares these two the EXTENSION's traffic. If MCP fed them, the daily digest
    // line would keep claiming a fact about the extension while counting agents too — and
    // nothing would reveal it, because the number would simply grow.
    expect(usage.anonRequests).toBe(0);
    expect(usage.authedRequests).toBe(0);
    expect(usage.beers).toBe(0);
  });

  it('an extension call leaves the MCP counters untouched', () => {
    const db = openDb(':memory:');
    migrate(db);
    recordMatchUsage(db, { date: '2026-09-10', authed: true, beers: 5, channel: 'extension' });

    const usage = getUsageForDate(db, '2026-09-10');
    expect(usage.authedRequests).toBe(1);
    expect(usage.beers).toBe(5);
    expect(usage.mcpRequests).toBe(0);
    expect(usage.mcpBeers).toBe(0);
  });

  it('both channels accumulate side by side on one date', () => {
    const db = openDb(':memory:');
    migrate(db);
    recordMatchUsage(db, { date: '2026-09-10', authed: false, beers: 3, channel: 'extension' });
    recordMatchUsage(db, { date: '2026-09-10', authed: true, beers: 4, channel: 'extension' });
    recordMatchUsage(db, { date: '2026-09-10', authed: true, beers: 9, channel: 'mcp' });

    const usage = getUsageForDate(db, '2026-09-10');
    expect(usage).toEqual({
      anonRequests: 1, authedRequests: 1, beers: 7, mcpRequests: 1, mcpBeers: 9,
    });
  });
```

Перевір наявні тести у файлі: ті, що викликають `recordMatchUsage` без `channel`, тепер не типізуються — додай їм `channel: 'extension'`, нічого іншого в них не міняючи. Якщо якийсь із них асертить `getUsageForDate` цілим об'єктом через `toEqual`, додай два нові поля з нулями.

У `src/api/routes/mcp.test.ts` додати (у наявний `describe`, з наявними хелперами `setup`/`rpc`/`INIT`):

```ts
  it('records MCP usage for a tool call, and not for the handshake', async () => {
    const { app, db } = setup();
    await rpc(app, INIT);
    // The handshake is not a match: initialize and tools/list must not inflate the counter.
    await rpc(app, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    expect(getUsageForDate(db, warsawDateAndHour(new Date()).date).mcpRequests).toBe(0);

    await rpc(app, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'match_beers', arguments: { beers: [
        { brewery: 'Trzech Kumpli', name: 'Pan IPAni' },
        { brewery: 'PINTA', name: 'Atak Chmielu' },
      ] } },
    });

    const usage = getUsageForDate(db, warsawDateAndHour(new Date()).date);
    expect(usage.mcpRequests).toBe(1);
    expect(usage.mcpBeers).toBe(2);
    expect(usage.authedRequests).toBe(0);
  });
```

Імпорти для цього тесту: `getUsageForDate` з `../../storage/api_usage`, `warsawDateAndHour` з `../../domain/warsaw-time`. `setup()` наразі не повертає `db` — якщо так, дописати його у повернений об'єкт, нічого іншого в `setup()` не міняючи.

- [ ] **Step 2: Запустити й побачити падіння**

Run: `npx vitest run src/storage/api_usage.test.ts src/api/routes/mcp.test.ts`
Expected: FAIL — `mcpRequests` не існує на `DailyUsage`, `channel` не приймається.

- [ ] **Step 3: Міграція**

У `src/storage/schema.ts`, одразу **після** запису `version: 29` і перед закриттям масиву:

```ts
  {
    version: 30,
    // MCP-канал (`POST /mcp`). §3.16 оголошує `anon_requests`/`authed_requests` трафіком
    // РОЗШИРЕННЯ, і щоденний дайджест друкує з них рядок «Розширення /match». Якби MCP
    // писав у ті самі лічильники, рядок і далі стверджував би факт про розширення,
    // рахуючи розширення ПЛЮС агентів, — і виявити підміну було б нізвідки, бо число
    // просто виросло б. Окремі колонки лишають історичні значення тим, чим вони були.
    // Проста ALTER TABLE ADD COLUMN: перебудова тут не потрібна, бо жодного CHECK
    // ця таблиця не має.
    sql: `
      ALTER TABLE api_usage ADD COLUMN mcp_requests INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE api_usage ADD COLUMN mcp_beers INTEGER NOT NULL DEFAULT 0;
    `,
  },
```

- [ ] **Step 4: Облік**

У `src/storage/api_usage.ts` — розширити тип і сигнатуру:

```ts
export interface DailyUsage {
  anonRequests: number;
  authedRequests: number;
  beers: number;
  mcpRequests: number;
  mcpBeers: number;
}

/**
 * Which surface produced the call. The two are counted apart on purpose: §3.16 declares
 * `anon_requests`/`authed_requests` the extension's traffic, and the digest line says so
 * out loud. A shared counter would keep the claim while quietly changing what it counts.
 */
export type UsageChannel = 'extension' | 'mcp';
```

Тіло `recordMatchUsage` — замінити на:

```ts
export function recordMatchUsage(
  db: DB,
  args: { date: string; authed: boolean; beers: number; channel: UsageChannel },
): void {
  const prevBusyTimeout = db.pragma('busy_timeout', { simple: true }) as number;
  db.pragma('busy_timeout = 0');
  try {
    // `authed` is meaningless for the MCP channel — that surface has no anonymous path at
    // all — so it is deliberately not folded into the MCP counters.
    const mcp = args.channel === 'mcp';
    db.prepare(`
      INSERT INTO api_usage (date, anon_requests, authed_requests, beers, mcp_requests, mcp_beers)
      VALUES (@date, @anon, @authed, @beers, @mcpRequests, @mcpBeers)
      ON CONFLICT(date) DO UPDATE SET
        anon_requests   = anon_requests   + excluded.anon_requests,
        authed_requests = authed_requests + excluded.authed_requests,
        beers           = beers           + excluded.beers,
        mcp_requests    = mcp_requests    + excluded.mcp_requests,
        mcp_beers       = mcp_beers       + excluded.mcp_beers
    `).run({
      date: args.date,
      anon: mcp ? 0 : (args.authed ? 0 : 1),
      authed: mcp ? 0 : (args.authed ? 1 : 0),
      beers: mcp ? 0 : args.beers,
      mcpRequests: mcp ? 1 : 0,
      mcpBeers: mcp ? args.beers : 0,
    });
  } finally {
    db.pragma(`busy_timeout = ${prevBusyTimeout}`);
  }
}
```

І `getUsageForDate` — читати п'ять колонок:

```ts
export function getUsageForDate(db: DB, date: string): DailyUsage {
  const row = db.prepare(
    `SELECT anon_requests, authed_requests, beers, mcp_requests, mcp_beers
       FROM api_usage WHERE date = ?`,
  ).get(date) as {
    anon_requests: number; authed_requests: number; beers: number;
    mcp_requests: number; mcp_beers: number;
  } | undefined;
  return {
    anonRequests: row?.anon_requests ?? 0,
    authedRequests: row?.authed_requests ?? 0,
    beers: row?.beers ?? 0,
    mcpRequests: row?.mcp_requests ?? 0,
    mcpBeers: row?.mcp_beers ?? 0,
  };
}
```

- [ ] **Step 5: Виклики**

У `src/api/routes/match.ts` — у наявному виклику `recordMatchUsage` додати `channel: 'extension'`. Більше нічого в роуті не міняти.

У `src/api/mcp/server.ts`, у хендлері тули, **перед** викликом `runMatchTool`, додати облік у тій самій best-effort формі, що вже є в `/match` (помилка запису не валить відповідь):

```ts
      // Operational usage metric for the daily digest — never break the response.
      // Counted here, in the tool handler, rather than in the route: the route also serves
      // initialize/tools/list, and a handshake is not a match.
      try {
        recordMatchUsage(deps.db, {
          date: warsawDateAndHour(new Date()).date,
          authed: true,          // /mcp has no anonymous path
          beers: beers.length,
          channel: 'mcp',
        });
      } catch (e) {
        deps.log.warn({ err: e }, 'api_usage record failed');
      }
```

Імпорти: `recordMatchUsage` з `../../storage/api_usage`, `warsawDateAndHour` з `../../domain/warsaw-time`.

- [ ] **Step 6: Запустити тести**

Run: `npx vitest run src/storage/api_usage.test.ts src/api/routes/mcp.test.ts src/api/routes/match.test.ts`
Expected: PASS.

- [ ] **Step 7: Мутаційна перевірка**

Замінити `mcpRequests: mcp ? 1 : 0` на `mcpRequests: 1`.
Run: `npx vitest run src/storage/api_usage.test.ts`
Expected: FAIL у `an extension call leaves the MCP counters untouched`. Повернути.

Замінити `anon: mcp ? 0 : (args.authed ? 0 : 1)` на `anon: args.authed ? 0 : 1`.
Expected: FAIL у `an MCP call increments ONLY the MCP counters` (MCP-виклик має `authed: true`, тож `anon` лишиться 0 — **якщо тест НЕ впаде, це і є знахідка**: значить розділення каналів не доведене цим асертом. Тоді додай у той самий тест окремий виклик `channel: 'mcp', authed: false` і переконайся, що `anonRequests` лишається 0). Повернути.

Перенести виклик `recordMatchUsage` у `src/api/mcp/server.ts` з хендлера тули в тіло `mcpRoute` (тобто рахувати кожен HTTP-запит).
Run: `npx vitest run src/api/routes/mcp.test.ts`
Expected: FAIL у `records MCP usage for a tool call, and not for the handshake`. Повернути.

- [ ] **Step 8: Прогін міграції на копії прод-БД**

Міграція незворотна на живих даних, тож перед комітом вона проганяється на **байтовій копії** прод-БД, а не лише на in-memory:

```bash
sudo -u warsaw-beer-bot cp /var/lib/warsaw-beer-bot/bot.db /tmp/claude-1000/prod-copy.db
sudo chown "$USER" /tmp/claude-1000/prod-copy.db
npx tsx -e "const {openDb}=require('./src/storage/db');const {migrate}=require('./src/storage/schema');const db=openDb('/tmp/claude-1000/prod-copy.db');migrate(db);console.log(db.prepare('SELECT * FROM api_usage ORDER BY date DESC LIMIT 3').all());console.log(db.prepare('SELECT MAX(version) AS v FROM schema_version').get());"
```

Очікується: `v = 30`, наявні рядки збережені, нові колонки з нулями. **Записати вивід у звіт.** Прибрати копію після перевірки. Якщо доступу до прод-БД нема — сказати про це прямо у звіті, а не пропустити крок мовчки.

- [ ] **Step 9: Повний гейт і коміт**

Run: `npm test && npm run typecheck`

```bash
git add src/storage/schema.ts src/storage/api_usage.ts src/storage/api_usage.test.ts src/api/routes/match.ts src/api/mcp/server.ts src/api/routes/mcp.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): окремі лічильники трафіку MCP замість підміни лічильників розширення

Міграція 30 додає api_usage.mcp_requests/mcp_beers, а recordMatchUsage
дістає channel. §3.16 оголошує anon_requests/authed_requests трафіком
розширення, і дайджест друкує з них рядок про розширення — спільний
лічильник зберіг би заяву, тихо змінивши те, що вона рахує.

Рахуємо в хендлері тули, не в роуті: роут обслуговує ще initialize і
tools/list, а рукостискання матчингом не є.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017j2cAZfbxWeSVRKGtGkJS6
EOF
)"
```

---

### Task 2: Рядок MCP у щоденному дайджесті

Лічильники з Task 1 нікому не видно, доки їх не друкує дайджест. Це водночас і звіт, і єдиний спосіб побачити, чи фічею взагалі користуються.

**Files:**
- Modify: `src/storage/stats.ts` (інтерфейс ~рядок 32-34, повернення ~рядок 225-227)
- Modify: `src/jobs/daily-status.ts` (рядок 37, новий одразу під ним)
- Test: `src/storage/stats.test.ts`, `src/jobs/daily-status.test.ts`

**Interfaces:**
- Consumes: `DailyUsage.mcpRequests`, `DailyUsage.mcpBeers` (Task 1).
- Produces: `mcpMatchRequests: number`, `mcpMatchBeers: number` у типі здоров'я, який читає `daily-status.ts`.

- [ ] **Step 1: Написати падаючі тести**

Файл `src/storage/stats.test.ts` використовує `test(...)`, не `it(...)`, а функція називається
**`collectStatus`** (не `collectHealth`). Наслідуй наявний тест
`collectStatus: extension /match metrics come from the previous Warsaw day` (рядок ~129) —
з нього ж бери `openDb`, `migrate`, `previousDate`, `warsawDateAndHour`:

```ts
test('collectStatus: MCP /match metrics are counted apart from the extension', () => {
  const db = openDb(':memory:');
  migrate(db);
  const now = new Date('2026-06-05T09:30:00Z');
  const yesterday = previousDate(warsawDateAndHour(now).date);
  // Distinct, non-equal values everywhere: equal seeds would let the two channels' fields
  // be swapped without any test noticing.
  recordMatchUsage(db, { date: yesterday, authed: true, beers: 11, channel: 'extension' });
  recordMatchUsage(db, { date: yesterday, authed: true, beers: 23, channel: 'mcp' });
  recordMatchUsage(db, { date: yesterday, authed: true, beers: 23, channel: 'mcp' });
  // Today's row must NOT be counted, same as for the extension line.
  recordMatchUsage(db, { date: warsawDateAndHour(now).date, authed: true, beers: 99, channel: 'mcp' });

  const m = collectStatus(db, now);
  expect(m.extMatchRequests).toBe(1);
  expect(m.extMatchBeers).toBe(11);
  expect(m.mcpMatchRequests).toBe(2);
  expect(m.mcpMatchBeers).toBe(46);
});
```

Наявний фікстурний об'єкт у цьому файлі (рядки ~61-75) перелічує **всі** поля здоров'я, включно
з `extMatchRequests`/`extMatchAnon`/`extMatchBeers`. Додай туди `mcpMatchRequests: 0` і
`mcpMatchBeers: 0` — без цього файл не типізується.

**`src/jobs/daily-status.test.ts` асертить ВЕСЬ текст дайджесту цілком** — `buildStatusMessage(base,
'2026-06-05 09:00')` порівнюється через `toBe([...].join('\n'))` з повним масивом рядків. Тобто
новий рядок **обов'язково** треба вставити в той масив, одразу після рядка
`'• Розширення /match (вчора): 1 234 запитів · 312 анонім. · 47 210 пив'`, інакше тест впаде на
всьому повідомленні. Це і є основна перевірка порядку — вона сильніша за окремий асерт. Вставити
рядок, що відповідає значенням у `base` (додай у `base` `mcpMatchRequests` і `mcpMatchBeers` з
**видимими, різними** числами, не нулями — напр. 87 і 1 940, і врахуй, що `group()` ставить
нерозривний пробіл у тисячах, як у сусідніх рядках).

Додатково — окремий тест на нулі, бо повний асерт покриває лише один набір значень:

```ts
test('buildStatusMessage: the MCP line shows zeros when there was no MCP traffic', () => {
  const out = buildStatusMessage(
    { ...base, mcpMatchRequests: 0, mcpMatchBeers: 0 },
    '2026-06-05 09:00',
  );
  expect(out).toContain('• MCP /match (вчора): 0 запитів · 0 пив');
});
```

- [ ] **Step 2: Запустити й побачити падіння**

Run: `npx vitest run src/storage/stats.test.ts src/jobs/daily-status.test.ts`
Expected: FAIL — полів немає.

- [ ] **Step 3: Реалізація**

У `src/storage/stats.ts`, поряд із `extMatchBeers` в інтерфейсі:

```ts
  mcpMatchRequests: number;   // MCP match_beers tool calls, previous Warsaw day
  mcpMatchBeers: number;      // sum of beers submitted through MCP, previous Warsaw day
```

і поряд із `extMatchBeers: usage.beers` у поверненні:

```ts
    mcpMatchRequests: usage.mcpRequests,
    mcpMatchBeers: usage.mcpBeers,
```

У `src/jobs/daily-status.ts`, **одразу після** рядка 37 (рядка про розширення):

```ts
    `• MCP /match (вчора): ${group(m.mcpMatchRequests)} запитів · ${group(m.mcpMatchBeers)} пив`,
```

Анонімного розрізнення тут нема навмисно — `/mcp` не має анонімного шляху.

- [ ] **Step 4: Запустити тести**

Run: `npx vitest run src/storage/stats.test.ts src/jobs/daily-status.test.ts`
Expected: PASS.

- [ ] **Step 5: Мутаційна перевірка**

Замінити `mcpMatchRequests: usage.mcpRequests` на `mcpMatchRequests: usage.anonRequests + usage.authedRequests`.
Expected: FAIL у новому тесті `collectStatus: MCP /match metrics are counted apart…`. Повернути.

Перенести новий рядок дайджесту на два рядки нижче в `daily-status.ts`.
Expected: FAIL у повному асерті `buildStatusMessage` (порядок рядків). Повернути.

- [ ] **Step 6: Повний гейт і коміт**

Run: `npm test && npm run typecheck`

```bash
git add src/storage/stats.ts src/storage/stats.test.ts src/jobs/daily-status.ts src/jobs/daily-status.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): рядок MCP у щоденному дайджесті під рядком розширення

Лічильники міграції 30 нікому не видно, доки їх не друкує дайджест. Це
водночас звіт і єдиний спосіб побачити, чи фічею користуються — і
підстава вирішувати, чи потрібен рейт-ліміт, за числами, а не на око.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017j2cAZfbxWeSVRKGtGkJS6
EOF
)"
```

---

### Task 3: `docs/mcp-uk.md` і його публікація

Сторінка, на яку веде команда `/extension`. Її **найважливіша** частина — не команди підключення, а симптом забутого токена: жива проба (`docs/pr-evidence/2026-09-10-mcp-client-probe.md`) показала, що Claude Code повідомляє про це як про помилку Dynamic Client Registration, ніде не згадуючи слова «токен».

**Files:**
- Create: `docs/mcp-uk.md`
- Modify: `scripts/render-docs.ts` (масив `TARGETS`, ~рядок 74)
- Modify: `scripts/render-docs.test.ts` (тест `renders all three targets without throwing` — цілей стає чотири)
- Modify: `.github/workflows/pages.yml` (фільтр `paths`)
- Modify: `site/index.html` (список посилань, ~рядок 48-52)

- [ ] **Step 1: Написати падаючі тести**

У `scripts/render-docs.test.ts` оновити наявний тест переліку цілей (він зараз чекає рівно три) і додати перевірку вмісту:

```ts
  it('renders all four targets without throwing', () => {
    expect(rendered.map((r) => r.out).sort()).toEqual([
      'site/changelog/index.html',
      'site/install-uk/index.html',
      'site/install/index.html',
      'site/mcp-uk/index.html',
    ]);
  });

  it('the MCP guide names the exact symptom of a missing token', () => {
    // The live probe (docs/pr-evidence/2026-09-10-mcp-client-probe.md) showed Claude Code
    // reports a forgotten token as an OAuth/DCR failure that never says "token". Without
    // this sentence on the page, every mistyped token sends someone hunting a problem
    // that does not exist.
    const mcp = rendered.find((r) => r.out === 'site/mcp-uk/index.html');
    expect(mcp).toBeDefined();
    expect(mcp!.html).toContain('Dynamic Client Registration');
    expect(mcp!.html).toContain('beer-api.ysilvestrov-ai.uk/mcp');
  });
```

Додати тест на фільтр workflow (є прецедент — `scripts/workflow-node-version.test.ts`; наслідуй його спосіб читати YAML як текст):

```ts
  it('the Pages workflow rebuilds when the MCP guide changes', () => {
    // A page whose source is outside the paths filter is published once and then never
    // updated again, silently.
    const yml = readFileSync(join(__dirname, '..', '.github/workflows/pages.yml'), 'utf8');
    expect(yml).toContain('docs/mcp-uk.md');
  });
```

- [ ] **Step 2: Запустити й побачити падіння**

Run: `npx vitest run scripts/render-docs.test.ts`
Expected: FAIL — три цілі замість чотирьох, файлу нема.

- [ ] **Step 3: Написати сторінку**

Створити `docs/mcp-uk.md`. Обов'язковий зміст (формулювання твої, факти — ці й лише ці):

1. **Що це.** Той самий матчинг, що робить браузерне розширення, але з твого агента: надсилаєш список пив — отримуєш, що з них уже випите й з якою оцінкою, і що каталог знає про кожне. Одна тула, `match_beers`.
2. **Токен.** Команда `/extension` у боті. Той самий токен, що для розширення; видача нового скасовує старий.
3. **Claude Code** — готовий рядок:
   ```
   claude mcp add --transport http warsaw-beer https://beer-api.ysilvestrov-ai.uk/mcp \
     --header "Authorization: Bearer ТВІЙ_ТОКЕН"
   ```
4. **Codex CLI** — готовий блок для `~/.codex/config.toml`:
   ```toml
   [mcp_servers.warsaw_beer]
   url = "https://beer-api.ysilvestrov-ai.uk/mcp"
   bearer_token_env_var = "WARSAW_BEER_TOKEN"
   ```
   з поясненням, що токен береться зі змінної середовища `WARSAW_BEER_TOKEN`.
5. **Що означають статуси** — таблиця з шести: `drunk`, `probably_drunk`, `not_drunk`, `unknown`, `not_in_catalog`, `not_searched`. Для `unknown` пояснити просто: ми нічого не знаємо про твою історію, бо її наповнює розширення — це не «ти не пив». Для `not_searched` — пошук по всьому каталогу має бюджет 20 позицій на запит, тож це «не шукали», а не «нема».
6. **Якщо не працює** — окремий розділ, дослівно з проби:
   - у Claude Code забутий або неправильний токен виглядає як `Dynamic Client Registration rejected (HTTP 404)`. Це **не** проблема з OAuth — це немає токена;
   - у Codex тула просто «недоступна», а справжня причина (`HTTP 401 unauthorized`) видима лише в потоці помилок.
7. **Межі** — до 200 пив на виклик; пивоварню й назву передавай окремими полями, а не одним рядком.

Не згадуй `spec.md`, номери issue, назви модулів чи внутрішні терміни (`fallback`, `fuzzy`, `catalog cache`) — сторінка для користувача.

- [ ] **Step 4: Підключити рендер**

У `scripts/render-docs.ts`, у масив `TARGETS`:

```ts
  { src: 'docs/mcp-uk.md', out: 'site/mcp-uk/index.html',
    lang: 'uk', title: 'Warsaw Beer — MCP для агентів', homeHref: '../' },
```

У `.github/workflows/pages.yml`, у фільтр `paths` — додати `'docs/mcp-uk.md'` до наявного списку.

У `site/index.html`, у список посилань після рядка з `changelog/`:

```html
      <li>🤖 <a href="mcp-uk/">MCP для Claude Code та Codex (українською)</a></li>
```

- [ ] **Step 5: Згенерувати сторінку і подивитися на неї**

Run: `npx tsx scripts/render-docs.ts`
Потім переконайся, що `site/mcp-uk/index.html` існує і містить обидва блоки підключення:
Run: `grep -c "claude mcp add\|bearer_token_env_var" site/mcp-uk/index.html`
Expected: ≥ 2.

- [ ] **Step 6: Запустити тести**

Run: `npx vitest run scripts/render-docs.test.ts`
Expected: PASS.

- [ ] **Step 7: Мутаційна перевірка**

Прибрати `'docs/mcp-uk.md'` з фільтра `paths` у `pages.yml`.
Expected: FAIL у тесті про workflow. Повернути.

Прибрати з `docs/mcp-uk.md` абзац про `Dynamic Client Registration`.
Expected: FAIL у тесті про симптом. Повернути.

- [ ] **Step 8: Повний гейт і коміт**

Run: `npm test && npm run typecheck`

```bash
git add docs/mcp-uk.md scripts/render-docs.ts scripts/render-docs.test.ts .github/workflows/pages.yml site/index.html site/mcp-uk/
git commit -m "$(cat <<'EOF'
docs(mcp): інструкція для користувача + публікація на GitHub Pages

Готові блоки підключення для Claude Code і Codex, значення шести статусів
людською мовою і — найважливіше — розділ про те, як виглядає забутий
токен. Жива проба показала, що Claude Code повідомляє про це як про
помилку Dynamic Client Registration, ніде не кажучи слова "токен"; без
цього абзацу кожна помилка з токеном жене людину шукати неіснуючу
проблему з OAuth.

docs/mcp-uk.md додано у фільтр paths у pages.yml: сторінка, чиє джерело
поза фільтром, публікується один раз і більше ніколи не оновлюється.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017j2cAZfbxWeSVRKGtGkJS6
EOF
)"
```

---

### Task 4: Рядок про MCP у команді `/extension`

Єдиний канал, яким люди про це дізнаються: анонси (#379) прив'язані до релізу розширення, а MCP до них не належить. Хто йде по токен — має побачити, що ним же працює MCP.

**Files:**
- Modify: `src/i18n/types.ts` (біля `'extension.store'`, ~рядок 104)
- Modify: `src/i18n/locales/uk.ts`, `en.ts`, `pl.ts` (~рядок 126)
- Modify: `src/bot/commands/extension.ts`
- Test: `src/bot/commands/extension.test.ts` (або наявний тест `buildExtensionMessage`), `src/i18n/index.test.ts`

- [ ] **Step 1: Написати падаючі тести**

У тесті, що покриває `buildExtensionMessage` (знайди його: `grep -rn "buildExtensionMessage" src --include=*.test.ts`):

```ts
  it('tells the token holder that the same token works for MCP, with the guide link', () => {
    const msg = buildExtensionMessage(t, 'deadbeef', 'https://example.test/match');
    expect(msg).toContain('https://ysilvestrov.github.io/warsaw-beer-bot/mcp-uk/');
  });

  it('escapes the MCP line like every other locale string', () => {
    // Telegraf HTML mode: an unescaped & or < in a locale string breaks parsing silently,
    // and the user gets no message at all.
    const hostile = ((key: string, vars?: Record<string, string>) =>
      key === 'extension.mcp' ? 'A & B <tag> {url}'.replace('{url}', vars?.url ?? '') : 'x') as Translator;
    const msg = buildExtensionMessage(hostile, 'deadbeef', 'u');
    expect(msg).toContain('A &amp; B &lt;tag&gt;');
    expect(msg).not.toContain('<tag>');
  });
```

(підлаштуй спосіб побудови фейкового `Translator` під той, що вже використовує цей тестовий файл — не вигадуй новий, якщо там є хелпер.)

Наявний тест повноти локалей (`src/i18n/index.test.ts`) впаде сам, щойно ключ з'явиться в `types.ts` і не з'явиться в усіх трьох локалях — це і є перевірка, що жодну мову не забуто. Переконайся, що такий тест існує; якщо ні — додай його.

- [ ] **Step 2: Запустити й побачити падіння**

Run: `npx vitest run src/bot/commands src/i18n`
Expected: FAIL.

- [ ] **Step 3: Реалізація**

У `src/i18n/types.ts`, після `'extension.store'`:

```ts
  'extension.mcp': string;       // {url} — MCP guide link; same token works for agents
```

У `src/i18n/locales/uk.ts`:

```ts
  'extension.mcp':
    'Цим самим токеном працює MCP — можна питати з Claude Code чи Codex, ' +
    'що з переліку пив ти вже пив і як оцінив: {url}',
```

У `en.ts`:

```ts
  'extension.mcp':
    'The same token also works over MCP — ask from Claude Code or Codex which beers ' +
    'on a list you have already had, and how you rated them: {url}',
```

У `pl.ts`:

```ts
  'extension.mcp':
    'Ten sam token działa też przez MCP — z Claude Code lub Codex możesz zapytać, ' +
    'które piwa z listy już piłeś i jak je oceniłeś: {url}',
```

У `src/bot/commands/extension.ts` — константа поряд із `API_URL`:

```ts
// User guide for the MCP endpoint, published from docs/mcp-uk.md to GitHub Pages.
const MCP_DOCS_URL = 'https://ysilvestrov.github.io/warsaw-beer-bot/mcp-uk/';
```

і третій блок у `buildExtensionMessage`:

```ts
export function buildExtensionMessage(t: Translator, token: string, url: string): string {
  const intro = escapeHtml(t('extension.success', { url }));
  const store = escapeHtml(t('extension.store', { url: STORE_URL }));
  const mcp = escapeHtml(t('extension.mcp', { url: MCP_DOCS_URL }));
  return `${intro}\n\n<code>${token}</code>\n\n${store}\n\n${mcp}`;
}
```

- [ ] **Step 4: Запустити тести**

Run: `npx vitest run src/bot/commands src/i18n`
Expected: PASS.

- [ ] **Step 5: Мутаційна перевірка**

Прибрати `escapeHtml` навколо `t('extension.mcp', …)`.
Expected: FAIL у тесті про екранування. Повернути.

Прибрати ключ `'extension.mcp'` з `pl.ts`.
Expected: FAIL у тесті повноти локалей. Повернути.

- [ ] **Step 6: Повний гейт і коміт**

Run: `npm test && npm run typecheck`

```bash
git add src/i18n/types.ts src/i18n/locales/uk.ts src/i18n/locales/en.ts src/i18n/locales/pl.ts src/bot/commands/extension.ts
git add src/bot/commands/extension.test.ts src/i18n/index.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): команда /extension розповідає про MCP тим самим токеном

Єдиний канал, яким про фічу дізнаються: анонси (#379) прив'язані до
релізу розширення, а MCP до них не належить. Хто вже йде по токен —
бачить, що ним же працює агент, і посилання на інструкцію.

Рядок проходить через escapeHtml, як усі інші локальні рядки: у
HTML-режимі Telegraf неекранований & або < ламає парсинг мовчки, і
користувач не отримує повідомлення взагалі.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017j2cAZfbxWeSVRKGtGkJS6
EOF
)"
```

---

### Task 5: `spec.md` і виправлення дизайн-документа

`spec.md` — єдине джерело істини за OpenSpec, а в проді вже живе ендпоінт, якого вона не знає, і `/match` уже віддає два поля, яких у ній нема.

**Files:**
- Modify: `spec.md`
- Modify: `docs/superpowers/specs/2026-09/2026-09-10-mcp-match-api-design.md` (одне речення)

**Розмір:** документація, повний код нижче не потрібен — але кожна правка названа точно. Виконує контролер **інлайн** лише якщо всі п'ять правок вміщаються без нових рішень; інакше диспатч.

- [ ] **Step 1: Нова підсекція `POST /mcp`**

У `spec.md`, у розділ «HTTP API», **одразу після** підсекції `#### POST /match` (вона закінчується перед `POST /enrich/*`), додати підсекцію `#### POST /mcp — MCP-сервер для агентів`. Зміст:

- транспорт: streamable HTTP, `@modelcontextprotocol/sdk`, **stateless** (`sessionIdGenerator: undefined`) і `enableJsonResponse: true`; чому саме так — сесія в пам'яті не переживає деплой, а другий довгоживий шлях крізь cloudflared це #124;
- **тільки POST**; GET/DELETE → `405 {"error":"method_not_allowed"}`. Причина названа прямо: `enableJsonResponse` керує лише відповідями на POST, тож `app.all` пустив би GET у SSE-гілку SDK з довгоживим стрімом і keep-alive-таймером;
- авторизація **обов'язкова** (`authMiddleware`), анонімного шляху нема — на відміну від `/match` (#245). Причина: анонімна відповідь має `is_drunk: false` на кожній позиції, і агент переказує це як «ти нічого з цього не пив»;
- ліміт тіла — `MATCH_BODY_LIMIT_BYTES` (256 KiB), змонтований **перед** автентифікацією;
- рівно одна тула `match_beers`, вхід `beers: [{brewery, name, abv?}]`, 1..200, обидва текстові поля обов'язкові;
- вихід: `profile { checkins_known, untappd_had_known, latest_checkin_at, drunk_set_empty }` і на кожну позицію `{ input, status, confidence, beer, your_rating }`;
- **таблиця шести статусів** із тим, що кожен стверджує: `drunk`, `probably_drunk`, `not_drunk`, `unknown`, `not_in_catalog`, `not_searched`. Обов'язково зафіксувати два розрізнення: `not_in_catalog` ≠ `not_searched` (бюджет 20 на запит), і `not_drunk` → `unknown` при порожньому drunk-set;
- помилка виконання тули приходить як **HTTP 200 із JSON-RPC `result`, у якому `isError: true`** — не як JSON-RPC `error`;
- клієнти: Claude Code (`--header`) і Codex CLI (`bearer_token_env_var`); claude.ai/десктоп **не** підтримується, бо custom connectors там приймають лише OAuth. Послатися на `docs/mcp-uk.md`.

- [ ] **Step 2: Контракт `/match` — два нові поля**

У підсекції `#### POST /match`, у зразку відповіді додати до кожного елемента `results`:

```
      "source": "exact",
      "searched": true
```

і абзац під зразком: `source` (`exact`/`fuzzy`/`null`) — як саме досягнуто рядок каталогу; `searched: false` — бюджетований повнокаталожний fuzzy-fallback (`FULL_FALLBACK_BUDGET`, 20 на запит) для цієї позиції **не запускався**, тож `matched_beer: null` тут означає «не шукали», а не «нема в каталозі»; exact-стадії при цьому відпрацювали. Поля адитивні, старі клієнти розширення їх ігнорують.

- [ ] **Step 3: §3.16 і таблиця міграцій**

У §3.16 (`api_usage`) додати два рядки таблиці:

| `mcp_requests` | INTEGER | NOT NULL DEFAULT 0 | виклики тули `match_beers` через `/mcp` за добу |
| `mcp_beers` | INTEGER | NOT NULL DEFAULT 0 | сума `beers[]` у MCP-викликах за добу |

і уточнити текст під таблицею: `anon_requests`/`authed_requests`/`beers` лишаються трафіком **розширення**; MCP до них не торкається навмисно, інакше рядок дайджесту зберіг би заяву про розширення, тихо змінивши те, що рахує.

У таблицю міграцій додати рядок:

```
| 30 | `api_usage.mcp_requests`/`mcp_beers` — окремий облік MCP-каналу. Прості `ALTER TABLE ADD COLUMN` без перебудови (у таблиці нема жодного `CHECK`). Окремі колонки, а не спільні: §3.16 оголошує наявні лічильники трафіком розширення, і дайджест друкує з них рядок про розширення |
```

- [ ] **Step 4: Опис дайджесту**

У таблиці крон-джоб, у клітинці `dailyStatus`, після речення про рядок «Розширення /match (вчора)» додати: одразу під ним іде рядок **«MCP /match (вчора)»** — запитів і пив за останню повну варшавську добу з колонок `mcp_*`. Анонімного розрізнення нема: `/mcp` не має анонімного шляху.

- [ ] **Step 5: Виправити хибне речення в дизайн-документі**

У `docs/superpowers/specs/2026-09/2026-09-10-mcp-match-api-design.md`, у розділі «Помилки», речення `` `isError` лишається для справжніх збоїв (перезбірка кешу каталогу впала) → JSON-RPC error `` — **невірне**, і це доведено тестом у стадії ядра. Замінити на: `isError` лишається для справжніх збоїв (перезбірка кешу каталогу впала); SDK ловить кинуту помилку в хендлері `tools/call` і повертає її як **звичайний JSON-RPC `result` з HTTP 200, усередині якого `isError: true`** — верхньорівневого JSON-RPC `error` при цьому не буває. Додати одне речення, що це з'ясовано читанням коду SDK і закріплено тестом.

- [ ] **Step 6: Перевірити, що нічого не забуто**

Run: `grep -n "mcp\|/mcp" spec.md | head -30`
Переконайся, що згадані: підсекція `POST /mcp`, дві колонки §3.16, рядок міграції 30, рядок дайджесту. Прогнати `npm test && npm run typecheck` (тести читають `spec.md` лише опосередковано, але гейт єдиний для всіх задач).

- [ ] **Step 7: Коміт**

```bash
git add spec.md docs/superpowers/specs/2026-09/2026-09-10-mcp-match-api-design.md
git commit -m "$(cat <<'EOF'
docs: spec.md дізнається про /mcp, два нові поля /match і міграцію 30

Ендпоінт уже працює, а спека його не знала; /match уже віддає source і
searched, яких у контракті не було. Плюс виправлено хибне речення у
власному дизайн-документі: SDK віддає збій тули як HTTP 200 з
result.isError, а не як JSON-RPC error — з'ясовано читанням коду SDK і
закріплено тестом ще в стадії ядра.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017j2cAZfbxWeSVRKGtGkJS6
EOF
)"
```

---

## Наскрізне рев'ю стадії обв'язки

Після Task 5 — одне рев'ю на всю стадію, свіжими очима. Питання, які воно має поставити прямо:

1. Чи існує шлях, яким MCP-виклик потрапляє в лічильники розширення (або навпаки)?
2. Чи рахується рукостискання (`initialize`, `tools/list`) як матчинг?
3. Чи міграція 30 справді ідемпотентна на БД, де вона вже застосована, і чи не ламає вона старі рядки?
4. Чи `docs/mcp-uk.md` не містить внутрішніх термінів і чи справді називає симптом забутого токена дослівно?
5. Чи всі три локалі мають новий ключ і чи всі проходять через `escapeHtml`?
6. Чи `spec.md` тепер описує **все**, що ендпоінт реально робить, — включно з 405 на GET і формою помилки тули?

## Перед PR

1. `git fetch origin main` (при `GitHub is temporarily limiting…` — форма з `gh auth token` із CLAUDE.md), далі `git rebase origin/main`.
2. **Повний гейт наново після рібейсу** — рібейс ламає гілку й тоді, коли обидві сторони були зелені окремо.
3. `git push --force-with-lease`.
4. У тілі PR назвати: обидві стадії, міграцію 30, новий публічний ендпоінт і те, що `docs/mcp-uk.md` публікується на Pages.
5. PR **мерджить користувач**, не агент.
