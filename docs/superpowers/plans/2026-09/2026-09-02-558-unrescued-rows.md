# #558 — третій термінальний стан `unrescued`: план реалізації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** рядок, який реплей при фіксі визнав неврятовним, перестає діставати безкоштовне обнулення бекофу на закриття issue — але не запечатується й лишається видимим.

**Architecture:** дві колонки в `enrich_failures` (`unrescued_at`, `unrescued_issue`), guard у `unlock-fixed-orphans`, який для позначеного рядка пропускає `rearmLookup` (але не `markUnlocked`), інструмент адюдикації в `src/` з live-пробою, і дві цифри в денному дайджесті. Маркер знімається механічно: будь-який виклик `rearmLookup` його чистить, а unlock для позначених рядків його просто не кличе.

**Tech Stack:** TypeScript, better-sqlite3, Vitest, pino.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-02-558-unrescued-rows-design.md`

## Global Constraints

- **Кожна задача проганяє ПОВНИЙ набір**: `npm test && npm run typecheck`. Звужений per-task гейт уже пропустив регресію крізь чотири чисті рев'ю на #527 — не звужувати.
- **Кожен тест мутаційно доведений**: зламай перевірку, побач червоне, поверни. Тест, який не показали червоним, не рахується (у проєкті вже було 4 порожні, але зелені тести за один прогін).
- **`retired_at` не пишеться ніде в цій роботі.** Новий стан живе у власних колонках; злиття з `retired_at` осліпить `sealRetiredFalsified`.
- **`review_class` не чіпається.** Клас каже, який це дефект; маркер каже, що конкретний фікс до нього не дотягнувся.
- **Маркер не виключає рядок із пулів.** Жоден предикат пулу (`orphanNotOnTapPredicate`, `onLatestTapPredicate`, `lockedRowPredicate`) не має згадувати `unrescued_at`. Якщо на рев'ю виявиться, що якийсь споживач читає його як виключення — це дефект.
- **Транзієнт не є вердиктом.** Адюдикація ставить маркер лише на `not_found`; `transient`/`blocked` не пишуть нічого (урок #316).
- **Правило йде в обидва файли** — `CLAUDE.md` і `AGENTS.md`, кожен своїм голосом.
- Якщо працюєш у воркtree: перед кожним комітом перевір `git rev-parse --show-toplevel` і `git branch --show-current` — імплементер уже одного разу комітив у головний чекаут.

---

### Task 1: колонки маркера, запис і механічне зняття

**Files:**
- Modify: `src/storage/schema.ts` (додати міграцію v27 у кінець `MIGRATIONS`, після `version: 26`)
- Modify: `src/storage/enrich_failures.ts` (додати `markUnrescued`, `clearUnrescued`; розширити `listLockedRows`)
- Modify: `src/storage/beers.ts:139-142` (`rearmLookup` чистить маркер)
- Test: `src/storage/enrich_failures.test.ts`, `src/storage/beers.test.ts`

**Interfaces:**
- Consumes: `openDb`, `migrate`, `recordEnrichFailure`, `setEnrichFailureReview` (наявні).
- Produces:
  - `markUnrescued(db: DB, beerId: number, issueNumber: number, atIso: string): boolean` — `true`, якщо рядок позначено; `false`, якщо рядка немає або він уже позначений (ідемпотентність).
  - `clearUnrescued(db: DB, beerId: number): void`
  - `listLockedRows(db)` тепер повертає `{ beer_id: number; issue_number: number; unrescued: boolean }[]`.

- [ ] **Step 1: Write the failing tests**

У `src/storage/enrich_failures.test.ts`:

```ts
import { markUnrescued, clearUnrescued, listLockedRows } from './enrich_failures';

function orphanWithIssue(db: DB, beerId: number, issue: number) {
  upsertBeer(db, { untappd_id: null, name: `n${beerId}`, brewery: `b${beerId}`,
    normalized_name: `n${beerId}`, normalized_brewery: `b${beerId}` });
  recordEnrichFailure(db, { beer_id: beerId, brewery: `b${beerId}`, name: `n${beerId}`,
    search_url: 'u', source_url: '', outcome: 'not_found', candidates_count: 0,
    candidates_summary: '', at: '2026-09-01T00:00:00Z' });
  setEnrichFailureReview(db, beerId, 'parser_bug', 'note', '2026-09-01T00:00:00Z', issue);
}

it('marks a row unrescued and records which fix proved it', () => {
  const db = fresh();
  orphanWithIssue(db, 1, 558);
  expect(markUnrescued(db, 1, 558, '2026-09-02T10:00:00Z')).toBe(true);
  const row = db.prepare('SELECT unrescued_at, unrescued_issue FROM enrich_failures WHERE beer_id = 1')
    .get() as { unrescued_at: string; unrescued_issue: number };
  expect(row.unrescued_at).toBe('2026-09-02T10:00:00Z');
  expect(row.unrescued_issue).toBe(558);
});

it('is idempotent: a second mark neither overwrites the timestamp nor reports a change', () => {
  const db = fresh();
  orphanWithIssue(db, 1, 558);
  markUnrescued(db, 1, 558, '2026-09-02T10:00:00Z');
  expect(markUnrescued(db, 1, 999, '2026-09-03T10:00:00Z')).toBe(false);
  const row = db.prepare('SELECT unrescued_at, unrescued_issue FROM enrich_failures WHERE beer_id = 1')
    .get() as { unrescued_at: string; unrescued_issue: number };
  expect(row.unrescued_at).toBe('2026-09-02T10:00:00Z');
  expect(row.unrescued_issue).toBe(558);
});

it('never writes retired_at', () => {
  const db = fresh();
  orphanWithIssue(db, 1, 558);
  markUnrescued(db, 1, 558, '2026-09-02T10:00:00Z');
  const row = db.prepare('SELECT retired_at FROM enrich_failures WHERE beer_id = 1')
    .get() as { retired_at: string | null };
  expect(row.retired_at).toBeNull();
});

it('listLockedRows reports the marker so the unlock job can act on it', () => {
  const db = fresh();
  orphanWithIssue(db, 1, 558);
  orphanWithIssue(db, 2, 558);
  markUnrescued(db, 1, 558, '2026-09-02T10:00:00Z');
  const rows = listLockedRows(db).sort((a, b) => a.beer_id - b.beer_id);
  expect(rows.map((r) => [r.beer_id, r.unrescued])).toEqual([[1, true], [2, false]]);
});
```

У `src/storage/beers.test.ts`:

```ts
it('rearmLookup clears the unrescued marker — an explicit re-arm is new evidence', () => {
  const db = fresh();
  orphanWithIssue(db, 1, 558);
  markUnrescued(db, 1, 558, '2026-09-02T10:00:00Z');
  rearmLookup(db, 1);
  const row = db.prepare('SELECT unrescued_at, unrescued_issue FROM enrich_failures WHERE beer_id = 1')
    .get() as { unrescued_at: string | null; unrescued_issue: number | null };
  expect(row.unrescued_at).toBeNull();
  expect(row.unrescued_issue).toBeNull();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/storage/enrich_failures.test.ts src/storage/beers.test.ts`
Expected: FAIL — `markUnrescued is not a function`, і `no such column: unrescued_at`.

- [ ] **Step 3: Add migration v27**

У `src/storage/schema.ts`, останнім елементом масиву `MIGRATIONS` (після блоку `version: 26`):

```ts
  {
    version: 27,
    // #558: третій термінальний стан. `retired_at` стверджує «фікс розв'язав проблему» і
    // стережеться `sealRetiredFalsified`; тут твердження інше — «фікс приїхав, і реплей
    // довів, що ЦЕЙ рядок він не рятує». Окремі колонки саме тому, що змішування зробило б
    // сторожа сліпим. `unrescued_issue` — машиночитана причина (#508 виставив рахунок за
    // 250 рядків із причиною у вільному тексті). Пулів це не змінює: рядок лишається
    // в пулі зі своїм бекофом, ми відбираємо лише безкоштовне обнулення лічильника.
    sql: `
      ALTER TABLE enrich_failures ADD COLUMN unrescued_at TEXT;
      ALTER TABLE enrich_failures ADD COLUMN unrescued_issue INTEGER;
    `,
  },
```

- [ ] **Step 4: Implement the storage functions**

У `src/storage/enrich_failures.ts`, поруч із `retireEnrichFailure`:

```ts
// #558: «фікс приїхав, і реплей довів, що цього рядка він не рятує». НЕ термінальний у
// сенсі retired_at: рядок лишається в пулі й доживає свій бекоф — знімається лише
// безкоштовне обнулення лічильника, яке дає закриття issue. review_class зберігається
// (клас каже, ЯКИЙ це дефект; маркер — що конкретний фікс до нього не дотягнувся).
// Ідемпотентний: WHERE unrescued_at IS NULL, тож повторний запуск не рухає таймстемп.
export function markUnrescued(
  db: DB,
  beerId: number,
  issueNumber: number,
  atIso: string,
): boolean {
  const info = db
    .prepare(
      `UPDATE enrich_failures
          SET unrescued_at = ?, unrescued_issue = ?
        WHERE beer_id = ? AND unrescued_at IS NULL`,
    )
    .run(atIso, issueNumber, beerId);
  return info.changes > 0;
}

// #558: знімається завжди разом із явним ре-армом (див. rearmLookup), бо ре-арм означає
// нове свідчення. Окрема функція, щоб ops-шлях міг зняти маркер без ре-арму.
export function clearUnrescued(db: DB, beerId: number): void {
  db.prepare(
    'UPDATE enrich_failures SET unrescued_at = NULL, unrescued_issue = NULL WHERE beer_id = ?',
  ).run(beerId);
}
```

І розширити `listLockedRows` (`src/storage/enrich_failures.ts:127`):

```ts
export function listLockedRows(
  db: DB,
): { beer_id: number; issue_number: number; unrescued: boolean }[] {
  const rows = db
    .prepare(
      `SELECT beer_id, issue_number, unrescued_at FROM enrich_failures
        WHERE review_class IN ('matcher_bug', 'parser_bug')
          AND issue_number IS NOT NULL
          AND unlocked_at IS NULL
          AND retired_at IS NULL`,
    )
    .all() as { beer_id: number; issue_number: number; unrescued_at: string | null }[];
  return rows.map((r) => ({
    beer_id: r.beer_id,
    issue_number: r.issue_number,
    unrescued: r.unrescued_at !== null,
  }));
}
```

- [ ] **Step 5: Make `rearmLookup` clear the marker**

У `src/storage/beers.ts`, замінити тіло `rearmLookup` (рядки 139-142):

```ts
// #421: скидає бекоф, щоб рядок дістав ще одну спробу.
// #558: і ЗАВЖДИ чистить маркер `unrescued`. Це механічно безпечно саме тому, що
// unlock-fixed-orphans для позначених рядків цю функцію взагалі не кличе — отже будь-який
// виклик, що сюди дійшов, є явним свідченням (ops-ре-арм або нова ABV у ensureBeerRow),
// а маркер стверджував лише «на СЬОГОДНІ безкоштовна спроба нічого не купить».
export function rearmLookup(db: DB, beerId: number): void {
  db.prepare('UPDATE beers SET untappd_lookup_at = NULL, untappd_lookup_count = 0 WHERE id = ?')
    .run(beerId);
  db.prepare(
    'UPDATE enrich_failures SET unrescued_at = NULL, unrescued_issue = NULL WHERE beer_id = ?',
  ).run(beerId);
}
```

- [ ] **Step 6: Run the full gate**

Run: `npm test && npm run typecheck`
Expected: усе зелене.

- [ ] **Step 7: Mutation-prove the tests**

Тимчасово прибери `AND unrescued_at IS NULL` з `markUnrescued` → тест ідемпотентності має впасти. Тимчасово прибери другий `db.prepare` з `rearmLookup` → тест зняття маркера має впасти. Поверни обидва, перевір зелене.

- [ ] **Step 8: Commit**

```bash
git add src/storage/schema.ts src/storage/enrich_failures.ts src/storage/beers.ts \
        src/storage/enrich_failures.test.ts src/storage/beers.test.ts
git commit -m "feat(#558): add the unrescued marker, and clear it on any explicit re-arm"
```

---

### Task 2: guard у `unlock-fixed-orphans`

**Files:**
- Modify: `src/jobs/unlock-fixed-orphans.ts:86-92` (цикл розмикання) та `UnlockOutcome`
- Test: `src/jobs/unlock-fixed-orphans.test.ts`

**Interfaces:**
- Consumes: `listLockedRows(db)` з полем `unrescued` (Task 1); `markUnrescued` (Task 1) — у тестах.
- Produces: `UnlockOutcome` отримує поле `rearmSkipped: number`.

- [ ] **Step 1: Write the failing test**

Файл уже має хелпер `seedLocked(db, name, cls, issue): number` (рядок 36) — **користуйся ним**,
не заводь свій. Він уже перевіряє, що `setEnrichFailureReview` повернув `'written'`
(інакше сід міг би тихо не записатись і тест був би зеленим ні про що).

```ts
import { markUnrescued } from '../storage/enrich_failures';

// Обидві сироти під замком на issue 700, яка вже НЕ у відкритому наборі (stubGithub([])).
it('unlocks a marked row but does NOT re-arm it — the closure cannot rescue it', async () => {
  const db = fresh();
  const beerId = seedLocked(db, 'frozen', 'parser_bug', 700);
  db.prepare('UPDATE beers SET untappd_lookup_count = 3, untappd_lookup_at = ? WHERE id = ?')
    .run('2026-08-01T00:00:00Z', beerId);
  expect(markUnrescued(db, beerId, 700, '2026-09-01T00:00:00Z')).toBe(true);

  const out = await unlockFixedOrphans({ db, log, github: stubGithub([]), now: NOW });

  expect(out.unlocked).toBe(1);
  expect(out.rearmSkipped).toBe(1);
  const beer = getBeer(db, beerId)!;
  expect(beer.untappd_lookup_count).toBe(3);            // лічильник НЕ обнулено
  expect(beer.untappd_lookup_at).toBe('2026-08-01T00:00:00Z');
  const row = db.prepare('SELECT unlocked_at, unrescued_at FROM enrich_failures WHERE beer_id = ?')
    .get(beerId) as { unlocked_at: string | null; unrescued_at: string | null };
  expect(row.unlocked_at).not.toBeNull();               // замок усе одно знято
  expect(row.unrescued_at).not.toBeNull();              // маркер лишається
});

it('still re-arms an unmarked row', async () => {
  const db = fresh();
  const beerId = seedLocked(db, 'ordinary', 'matcher_bug', 700);
  db.prepare('UPDATE beers SET untappd_lookup_count = 3, untappd_lookup_at = ? WHERE id = ?')
    .run('2026-08-01T00:00:00Z', beerId);

  const out = await unlockFixedOrphans({ db, log, github: stubGithub([]), now: NOW });

  expect(out.rearmSkipped).toBe(0);
  const beer = getBeer(db, beerId)!;
  expect(beer.untappd_lookup_count).toBe(0);
  expect(beer.untappd_lookup_at).toBeNull();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/jobs/unlock-fixed-orphans.test.ts`
Expected: FAIL — `rearmSkipped` is `undefined`, і лічильник обнулено попри маркер.

- [ ] **Step 3: Implement the guard**

У `src/jobs/unlock-fixed-orphans.ts` розширити `UnlockOutcome`:

```ts
export interface UnlockOutcome {
  unlocked: number;
  issuesClosed: number;
  // #558: скільки рядків розімкнено БЕЗ перезарядки, бо реплей при фіксі довів, що
  // закриття цієї issue їх не рятує. Окремо від `unlocked`, бо замок таки знято.
  rearmSkipped: number;
  skippedReason: string | null;
  error: string | null;
}
```

Оновити `empty` і всі повернення, що його розгортають, додавши `rearmSkipped: 0`, і замінити цикл:

```ts
  let unlocked = 0;
  let rearmSkipped = 0;
  for (const row of locked) {
    if (!closed.has(row.issue_number)) continue;
    // #558: маркер означає «реплей при фіксі довів, що цей рядок фікс не рятує», тож
    // безкоштовне обнулення бекофу купило б лише до 4 лукапів, які не можуть влучити.
    // markUnlocked лишається: issue справді закрита, замок справді знято — рядок просто
    // повертається в пул зі своїм наявним бекофом, а не з обнуленим.
    if (row.unrescued) rearmSkipped += 1;
    else rearmLookup(db, row.beer_id);
    markUnlocked(db, row.beer_id, atIso);
    unlocked += 1;
  }

  setJobState(db, UNLOCK_LAST_RUN_KEY, date);
  log.info({ unlocked, rearmSkipped, issuesClosed: closed.size }, 'unlock-fixed-orphans finished');
  return { unlocked, rearmSkipped, issuesClosed: closed.size, skippedReason: null, error: null };
```

- [ ] **Step 4: Run the full gate**

Run: `npm test && npm run typecheck`
Expected: усе зелене.

- [ ] **Step 5: Add the source guard that the marker never becomes a pool exclusion**

Головний ризик цієї роботи — повторити опік #412, де рядок вилетів з обох пулів. Юніт-тест
цього не спіймає: небезпека в тому, що хтось ПІЗНІШЕ допише `unrescued_at` у предикат пулу.
Тому — source-guard, у стилі наявних інваріантів композиційного кореня:

```ts
import { readFileSync } from 'node:fs';

// #558: маркер знімає лише безкоштовне обнулення бекофу. Щойно він потрапить у предикат
// пулу, рядок зникне з обігу — рівно те, що #412 вже коштувало 157 рядків.
it('no pool predicate reads the unrescued marker', () => {
  const src = readFileSync(new URL('../storage/beers.ts', import.meta.url), 'utf8');
  for (const name of ['orphanNotOnTapPredicate', 'onLatestTapPredicate', 'lockedRowPredicate']) {
    const start = src.indexOf(`export const ${name}`);
    expect(start, `${name} not found`).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('`;', start));
    expect(body).not.toContain('unrescued');
  }
});
```

Мутаційна перевірка: тимчасово додай `AND ef.unrescued_at IS NULL` до
`orphanNotOnTapPredicate` → тест має впасти. Поверни.

- [ ] **Step 6: Mutation-prove the guard**

Заміни `if (row.unrescued) rearmSkipped += 1; else rearmLookup(...)` на безумовний `rearmLookup(...)` → перший тест має впасти на `untappd_lookup_count`. Поверни.

- [ ] **Step 7: Commit**

```bash
git add src/jobs/unlock-fixed-orphans.ts src/jobs/unlock-fixed-orphans.test.ts
git commit -m "feat(#558): closing an issue no longer re-arms a row it provably cannot rescue"
```

---

### Task 3: інструмент адюдикації

**Files:**
- Create: `src/jobs/adjudicate-issue-rows.ts`
- Test: `src/jobs/adjudicate-issue-rows.test.ts`

**Interfaces:**
- Consumes: `markUnrescued` (Task 1); `lookupBeer(args: { brewery: string; name: string; abv?: number | null; search: BeerSearch }): Promise<LookupOutcome>` з `src/domain/untappd-lookup.ts`, де `LookupOutcome` = `{kind:'matched';result} | {kind:'not_found';searchUrls;candidates} | {kind:'transient';error} | {kind:'blocked';searchUrl}`.
- Produces: `adjudicateIssueRows(deps: AdjudicateDeps, issueNumber: number): Promise<AdjudicateResult>`.

Живе в `src/jobs/`, поруч зі `unlock-fixed-orphans.ts`/`enrich-orphans.ts`: це джоба (DI-залежності, юніт-тести), а не ops-скрипт. (Виправлення 2026-09-02: попереднє обґрунтування — «`scripts/` у проді не запускається, бо там немає `tsx`» — перевірено на живому сервері й спростовано: `tsx` є regular dependency, переживає `npm prune --omit=dev`, і `scripts/*.ts` реально їдуть у прод і запускаються там; див. `spec.md:1616` і `docs/superpowers/specs/2026-07/2026-07-20-ops-tools-prod-reachable-design.md`.)

- [ ] **Step 1: Write the failing test**

`orphanWithIssue(db, beerId, issue)` тут — локальний хелпер цього файлу: створює сироту
через `upsertBeer`, пише `recordEnrichFailure`, і ставить вердикт через
`setEnrichFailureReview`, **перевіривши, що той повернув `'written'`** (див. `seedLocked`
у `src/jobs/unlock-fixed-orphans.test.ts:36` як зразок — сід, який тихо не записався,
дає зелений тест ні про що).

```ts
import { adjudicateIssueRows } from './adjudicate-issue-rows';

it('marks a row whose live probe still finds nothing', async () => {
  const db = fresh();
  orphanWithIssue(db, 1, 558);
  const out = await adjudicateIssueRows(
    { db, log, lookup: async () => ({ kind: 'not_found', searchUrls: ['u'], candidates: [] }),
      now: () => new Date('2026-09-02T10:00:00Z') },
    558,
  );
  expect(out).toMatchObject({ probed: 1, marked: 1, rescued: 0, inconclusive: 0 });
  const row = db.prepare('SELECT unrescued_at, unrescued_issue FROM enrich_failures WHERE beer_id = 1')
    .get() as { unrescued_at: string; unrescued_issue: number };
  expect(row.unrescued_at).toBe('2026-09-02T10:00:00Z');
  expect(row.unrescued_issue).toBe(558);
});

it('does NOT mark a row the probe now matches — it reports a rescue and leaves the row alone', async () => {
  const db = fresh();
  orphanWithIssue(db, 1, 558);
  const out = await adjudicateIssueRows(
    { db, log, lookup: async () => ({ kind: 'matched', result: { bid: 42, name: 'x', brewery: 'y' } as never }),
      now: () => new Date('2026-09-02T10:00:00Z') },
    558,
  );
  expect(out).toMatchObject({ probed: 1, marked: 0, rescued: 1 });
  const row = db.prepare('SELECT unrescued_at FROM enrich_failures WHERE beer_id = 1')
    .get() as { unrescued_at: string | null };
  expect(row.unrescued_at).toBeNull();
});

it('NEVER marks on a transient or blocked probe — a network failure is not a verdict', async () => {
  for (const outcome of [{ kind: 'transient', error: new Error('boom') },
                         { kind: 'blocked', searchUrl: 'u' }] as const) {
    const db = fresh();
    orphanWithIssue(db, 1, 558);
    const out = await adjudicateIssueRows(
      { db, log, lookup: async () => outcome as never, now: () => new Date('2026-09-02T10:00:00Z') },
      558,
    );
    expect(out).toMatchObject({ marked: 0, inconclusive: 1 });
    const row = db.prepare('SELECT unrescued_at FROM enrich_failures WHERE beer_id = 1')
      .get() as { unrescued_at: string | null };
    expect(row.unrescued_at).toBeNull();
  }
});

it('touches no lookup counters — adjudication must not spend the row backoff', async () => {
  const db = fresh();
  orphanWithIssue(db, 1, 558);
  db.prepare('UPDATE beers SET untappd_lookup_count = 2, untappd_lookup_at = ? WHERE id = 1')
    .run('2026-08-01T00:00:00Z');
  await adjudicateIssueRows(
    { db, log, lookup: async () => ({ kind: 'not_found', searchUrls: ['u'], candidates: [] }),
      now: () => new Date('2026-09-02T10:00:00Z') },
    558,
  );
  const beer = getBeer(db, 1)!;
  expect(beer.untappd_lookup_count).toBe(2);
  expect(beer.untappd_lookup_at).toBe('2026-08-01T00:00:00Z');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/jobs/adjudicate-issue-rows.test.ts`
Expected: FAIL — модуля не існує.

- [ ] **Step 3: Implement the tool**

```ts
import type pino from 'pino';
import type { DB } from '../storage/db';
import type { LookupOutcome } from '../domain/untappd-lookup';
import { markUnrescued } from '../storage/enrich_failures';

// #558: адюдикація рядків одного фіксу. Політика вже вимагає реплею перед фіксом —
// різниця лише в тому, що досі його результат жив у чаті й помирав із сесією.
//
// Свідомо НЕ застосовує наслідків: не пише лінк на `matched`, не рухає бекоф на
// `not_found`. Інструмент виносить вердикт про долю рядка, а не робить роботу крона —
// інакше одна помилка в ньому псувала б каталог. Тому й `lookup` — це шов: у проді
// сюди передають `(beer) => lookupBeer({ ...beer, search })`.
export interface AdjudicateDeps {
  db: DB;
  log: pino.Logger;
  lookup: (beer: { brewery: string; name: string; abv: number | null }) => Promise<LookupOutcome>;
  now?: () => Date;
}

export interface AdjudicateResult {
  probed: number;
  rescued: number;       // проба знайшла пиво — рядок лишається як є, крон його злінкує
  marked: number;        // проба не знайшла нічого — маркер поставлено
  inconclusive: number;  // transient/blocked — не вердикт, нічого не пишемо (#316)
}

export async function adjudicateIssueRows(
  deps: AdjudicateDeps,
  issueNumber: number,
): Promise<AdjudicateResult> {
  const now = (deps.now ?? (() => new Date()))();
  const rows = deps.db
    .prepare(
      `SELECT b.id, b.brewery, b.name, b.abv
         FROM enrich_failures ef JOIN beers b ON b.id = ef.beer_id
        WHERE ef.issue_number = ?
          AND ef.retired_at IS NULL
          AND b.untappd_id IS NULL`,
    )
    .all(issueNumber) as { id: number; brewery: string; name: string; abv: number | null }[];

  const out: AdjudicateResult = { probed: 0, rescued: 0, marked: 0, inconclusive: 0 };
  for (const row of rows) {
    out.probed += 1;
    const outcome = await deps.lookup({ brewery: row.brewery, name: row.name, abv: row.abv });
    if (outcome.kind === 'matched') {
      out.rescued += 1;
      continue;
    }
    if (outcome.kind !== 'not_found') {
      // Мережевий збій — не свідчення про рядок. Позначити його тут означало б записати
      // «фікс тебе не рятує» на підставі того, що впав проксі.
      out.inconclusive += 1;
      deps.log.warn({ beerId: row.id, kind: outcome.kind }, 'adjudicate: inconclusive probe');
      continue;
    }
    if (markUnrescued(deps.db, row.id, issueNumber, now.toISOString())) out.marked += 1;
  }
  deps.log.info({ issueNumber, ...out }, 'adjudicate-issue-rows finished');
  return out;
}
```

- [ ] **Step 4: Run the full gate**

Run: `npm test && npm run typecheck`
Expected: усе зелене.

- [ ] **Step 5: Mutation-prove the transient guard**

Заміни `if (outcome.kind !== 'not_found')` на `if (false)` → тест про transient/blocked має впасти (маркер з'явиться). Поверни.

- [ ] **Step 6: Commit**

```bash
git add src/jobs/adjudicate-issue-rows.ts src/jobs/adjudicate-issue-rows.test.ts
git commit -m "feat(#558): adjudicate an issue's rows by live probe, marking only a settled miss"
```

---

### Task 4: дві цифри в дайджесті

**Files:**
- Modify: `src/storage/stats.ts` (інтерфейс метрик + два `count(...)`)
- Modify: `src/jobs/daily-status.ts:34` (рядок «Замок»)
- Test: `src/storage/stats.test.ts`, `src/jobs/daily-status.test.ts`

**Interfaces:**
- Consumes: `markUnrescued`, `markUnlocked` (Task 1 та наявна).
- Produces: у типі метрик — `unrescuedRows: number`, `unlockedUnadjudicated7d: number`.

- [ ] **Step 1: Write the failing test**

У `src/storage/stats.test.ts`:

```ts
it('counts unrescued rows, and unlocked rows nobody adjudicated', () => {
  const db = fresh();
  orphanWithIssue(db, 1, 558);
  orphanWithIssue(db, 2, 558);
  orphanWithIssue(db, 3, 558);
  markUnrescued(db, 1, 558, '2026-09-01T00:00:00Z');
  markUnlocked(db, 1, '2026-09-01T00:00:00Z');   // позначений і розімкнений
  markUnlocked(db, 2, '2026-09-01T00:00:00Z');   // розімкнений БЕЗ вердикту -> борг
  // 3 просто лежить під замком

  const m = collectStats(db, new Date('2026-09-02T00:00:00Z'));
  expect(m.unrescuedRows).toBe(1);
  expect(m.unlockedUnadjudicated7d).toBe(1);
  expect(m.sealRetiredFalsified).toBe(0);        // новий стан НЕ протікає в сторожа retire
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/storage/stats.test.ts`
Expected: FAIL — `unrescuedRows` is `undefined`.

- [ ] **Step 3: Implement the metrics**

У `src/storage/stats.ts`, поруч із `sealRetiredFalsified` у типі:

```ts
  // #558. `unrescuedRows` робить новий стан видимим, а не мовчазним. `unlockedUnadjudicated7d`
  // — міра ДОТРИМАННЯ правила: рядок, який розімкнули без вердикту адюдикації і який досі
  // сирота. Правило застосовують — цифра мала; тихо пропускають — росте. Обидві дешеві й
  // не потребують знімка стану: порівнювати outcome+candidates_count до/після перезарядки
  // було б неможливо без двох додаткових колонок, бо recordEnrichFailure їх перезаписує.
  unrescuedRows: number;
  unlockedUnadjudicated7d: number;
```

І в тілі, поруч із `sealRetiredFalsified`:

```ts
    unrescuedRows: count(
      'SELECT COUNT(*) AS c FROM enrich_failures WHERE unrescued_at IS NOT NULL',
    ),
    unlockedUnadjudicated7d: count(
      `SELECT COUNT(*) AS c FROM enrich_failures ef JOIN beers b ON b.id = ef.beer_id
        WHERE ef.unlocked_at >= ? AND ef.unrescued_at IS NULL AND b.untappd_id IS NULL`,
      [cutoff7d],
    ),
```

У `src/jobs/daily-status.ts:34` розширити рядок «Замок»:

```ts
    `• Замок: ${group(m.lockedRows)} під замком · ${group(m.unlocked7d)} розімкнено/7д · ${group(m.verdictsOutlived7d)} вердиктів пережили фікс/7д · ${group(m.unrescuedRows)} unrescued (${group(m.unlockedUnadjudicated7d)} розімкнено без вердикту/7д)`,
```

- [ ] **Step 4: Run the full gate**

Run: `npm test && npm run typecheck`
Expected: усе зелене. `daily-status.test.ts` може вимагати оновлення очікуваного рядка — онови його, а не тест на метрики.

- [ ] **Step 5: Mutation-prove the separation**

Тимчасово зміни `unrescuedRows` на `WHERE retired_at IS NOT NULL` → тест має впасти і на `unrescuedRows`, і показати, що стани справді різні. Поверни.

- [ ] **Step 6: Commit**

```bash
git add src/storage/stats.ts src/storage/stats.test.ts src/jobs/daily-status.ts src/jobs/daily-status.test.ts
git commit -m "feat(#558): surface the unrescued state and the unadjudicated-unlock debt"
```

---

### Task 5: правило в ранбуці

**Files:**
- Modify: `CLAUDE.md` (новий буліт)
- Modify: `AGENTS.md` (новий підрозділ)
- Modify: `spec.md` (якщо там описано життєвий цикл `enrich_failures` — перевірити й оновити)

**Interfaces:** немає коду.

- [ ] **Step 1: Перевір, чи `spec.md` описує стани `enrich_failures`**

Run: `grep -n "retired_at\|enrich_failures\|unlocked_at" spec.md`
Якщо життєвий цикл рядка там описано — додай третій стан у тому ж місці й тим самим голосом. Якщо ні — `spec.md` не чіпай і зазнач це в комміті.

- [ ] **Step 2: Додай буліт у `CLAUDE.md`**

Щільним стилем решти файлу, поруч із булітом про декомпозицію `orphan-triage`:

```markdown
- **Фікс `parser_bug`/`matcher_bug` ухвалює долю КОЖНОГО свого рядка**: реплей перед фіксом обов'язковий і так, тож його вивід має лягти в БД, а не померти з сесією. Кожен рядок issue виходить із фіксу в одному з трьох станів — врятований (крон його злінкує), позначений `unrescued_at` (жива проба нічого не знайшла: закриття issue більше не дасть йому безкоштовного обнулення бекофу), або лишається в пулі без маркера. **По рядку, ніколи гуртом** `WHERE issue_number = …`. Маркер **не запечатує**: рядок лишається в пулі зі своїм бекофом, а будь-який явний ре-арм його чистить. `transient`/`blocked` — не вердикт, на них не позначають нічого. Інструмент: `adjudicateIssueRows` (`src/jobs/`, поруч із `unlock-fixed-orphans.ts`/`enrich-orphans.ts` — це джоба, а не ops-скрипт: DI-залежності, юніт-тести, живе там, де решта джоб).
```

- [ ] **Step 3: Додай підрозділ в `AGENTS.md`**

Секційною прозою, як решта файлу:

```markdown
Adjudicating an issue's rows

Before closing a `parser_bug` or `matcher_bug` issue, every row that names it must leave the
fix in a known state. The replay you already have to run is the evidence; record it instead
of letting it die with the session.

Run the adjudication over the issue's rows. Each row ends in exactly one of three states:

- the probe found the beer — leave the row alone, the enrich cron will link it;
- the probe found nothing — the row is marked `unrescued_at`, so closing the issue no longer
  hands it a free backoff reset for lookups that cannot succeed;
- the probe was transient or blocked — write nothing. A network failure is not a verdict.

Do this per row. Never bulk-update by `WHERE issue_number = …`: a row whose fate you cannot
name individually keeps its current state.

The marker is not a seal. The row stays in its pool with its existing backoff, and any
explicit re-arm clears the marker — it asserts only "as of today, a free retry buys nothing".
```

- [ ] **Step 4: Verify both files carry it**

Run: `grep -c "unrescued" CLAUDE.md AGENTS.md`
Expected: обидва ≥ 1.

- [ ] **Step 5: Run the full gate**

Run: `npm test && npm run typecheck`
Expected: усе зелене (документація коду не ламає, але гейт однаковий для кожної задачі).

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md AGENTS.md spec.md
git commit -m "docs(#558): a parser/matcher fix must adjudicate every row it owns"
```

---

## Після всіх задач

- [ ] Відкрити PR і **дочекатися AI-рев'ю**, перевірити кожен коментар (зокрема на «carried» знахідки — цитата може збігатися, а дефект бути вже полагодженим вище за течією).
- [ ] Не мерджити самому — доповісти «готове до мерджу».
- [ ] Після мерджу задеплоїти й перевірити на проді: `schema_version` = 27, `unrescuedRows` = 0, рядок «Замок» у дайджесті містить нові поля.
