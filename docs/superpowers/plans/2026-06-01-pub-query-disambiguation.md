# Pub Query Disambiguation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дозволити команді `/newbeers` розрізняти паби-двійники за адресою через запит (`pinta nowogrodzka` → тільки Nowogrodzka pub).

**Architecture:** Витягуємо чисту функцію `filterPubsByQuery` з `newbeers-build.ts` яка реалізує двоетапний пошук: спочатку підрядок у назві, потім слова у `(name + address)` як уточнювач або fallback. `buildNewbeersMessage` делегує фільтрацію цій функції. `NewbeersResult` та `BeerGroup` — без змін.

**Tech Stack:** TypeScript, Jest, SQLite (better-sqlite3), наявні helpers у `src/bot/commands/newbeers-build.test.ts`.

---

## File Map

| Файл | Дія |
|---|---|
| `src/bot/commands/newbeers-build.ts` | Додати `filterPubsByQuery` як named export; замінити inline-логіку |
| `src/bot/commands/newbeers-build.test.ts` | Додати `describe('filterPubsByQuery')` з 6 тестами |

---

## Task 1: Скинути uncommitted чернетку

**Files:**
- Modify: `src/bot/commands/newbeers-build.ts`
- Modify: `src/bot/commands/newbeers-build.test.ts`

- [ ] **Step 1: Переконатися що uncommitted зміни існують**

```bash
git diff --stat HEAD
```

Expected: обидва файли показані як змінені.

- [ ] **Step 2: Скинути обидва файли до HEAD**

```bash
git checkout HEAD -- src/bot/commands/newbeers-build.ts src/bot/commands/newbeers-build.test.ts
```

Expected: no output (clean checkout).

- [ ] **Step 3: Перевірити що тести проходять у базовому стані**

```bash
npx jest newbeers-build --no-coverage 2>&1 | tail -15
```

Expected: `Tests: X passed` (без нових тестів), suite green.

---

## Task 2: Написати failing тести для `filterPubsByQuery`

**Files:**
- Modify: `src/bot/commands/newbeers-build.test.ts`

- [ ] **Step 1: Додати import `filterPubsByQuery` та describe-блок з 6 тестами**

Додати в кінець файлу `src/bot/commands/newbeers-build.test.ts` (перед останньою `}`):

```typescript
import { filterPubsByQuery } from './newbeers-build';
```

Замінити рядок 8 файлу (існуючий import):
```typescript
import { buildNewbeersMessage, filterPubsByQuery } from './newbeers-build';
```

Додати перед останнім `});` файлу новий describe-блок:

```typescript
describe('filterPubsByQuery', () => {
  const pubChmielna = {
    id: 1, slug: 'pinta-chmielna', name: 'PINTA Warszawa',
    address: 'Chmielna 7/9, Warszawa', lat: null, lon: null,
  };
  const pubNowogrodzka = {
    id: 2, slug: 'pinta-nowogrodzka', name: 'PINTA Warszawa',
    address: 'Nowogrodzka 4, Warszawa', lat: null, lon: null,
  };
  const pubKufel = {
    id: 3, slug: 'kufel', name: 'Kufel i Chmiel',
    address: 'Nowy Swiat 22, Warszawa', lat: null, lon: null,
  };
  const allPubs = [pubChmielna, pubNowogrodzka, pubKufel];

  test('unique name-match returns that pub without address check', () => {
    expect(filterPubsByQuery(allPubs, 'kufel')).toEqual([pubKufel]);
  });

  test('2 name-matches without disambiguating word returns both', () => {
    expect(filterPubsByQuery(allPubs, 'pinta warszawa')).toEqual([pubChmielna, pubNowogrodzka]);
  });

  test('2 name-matches + address word narrows to Nowogrodzka', () => {
    expect(filterPubsByQuery(allPubs, 'pinta nowogrodzka')).toEqual([pubNowogrodzka]);
  });

  test('2 name-matches + address word narrows to Chmielna', () => {
    expect(filterPubsByQuery(allPubs, 'pinta chmielna')).toEqual([pubChmielna]);
  });

  test('0 name-matches uses address fallback', () => {
    expect(filterPubsByQuery(allPubs, 'nowogrodzka')).toEqual([pubNowogrodzka]);
  });

  test('unknown query returns empty array', () => {
    expect(filterPubsByQuery(allPubs, 'xxxxxx')).toEqual([]);
  });
});
```

- [ ] **Step 2: Запустити тести — мають впасти через відсутній export**

```bash
npx jest newbeers-build --no-coverage 2>&1 | tail -15
```

Expected: compile error — `Module '"./newbeers-build"' has no exported member 'filterPubsByQuery'`.

---

## Task 3: Реалізувати `filterPubsByQuery` та інтегрувати в `buildNewbeersMessage`

**Files:**
- Modify: `src/bot/commands/newbeers-build.ts`

- [ ] **Step 1: Додати import `PubRow` та нову функцію перед `buildNewbeersMessage`**

Додати до рядка з imports у верхівці `src/bot/commands/newbeers-build.ts`:

```typescript
import { listPubs, type PubRow } from '../../storage/pubs';
```

(замінити існуючий `import { listPubs }` — додати `, type PubRow`).

Додати одразу після блоку imports (перед `export interface NewbeersDeps`):

```typescript
export function filterPubsByQuery(pubs: PubRow[], query: string): PubRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return pubs;

  const nameMatches = pubs.filter((p) => p.name.toLowerCase().includes(q));

  if (nameMatches.length === 1) return nameMatches;

  const words = q.split(/\s+/).filter(Boolean);
  const searchBase = nameMatches.length === 0 ? pubs : nameMatches;
  const combined = searchBase.filter((p) =>
    words.every((w) => (p.name + ' ' + (p.address ?? '')).toLowerCase().includes(w)),
  );

  if (nameMatches.length === 0) return combined;
  return combined.length === 1 ? combined : nameMatches;
}
```

- [ ] **Step 2: Замінити inline-логіку в `buildNewbeersMessage`**

Замінити весь блок `if (q) { ... }` в `buildNewbeersMessage` (приблизно рядки 44–70) на:

```typescript
  if (q) {
    const filtered = filterPubsByQuery([...pubs.values()], q);
    if (filtered.length === 0) return { kind: 'pub_not_found', query: deps.pubQuery! };
    matchedIds = new Set(filtered.map((p) => p.id));
  }
```

- [ ] **Step 3: Запустити тести `filterPubsByQuery` — мають пройти**

```bash
npx jest newbeers-build --no-coverage 2>&1 | tail -15
```

Expected: всі 6 нових тестів + існуючі — `Tests: N passed`, suite green.

- [ ] **Step 4: Запустити повний suite**

```bash
npx jest --no-coverage 2>&1 | tail -10
```

Expected: `Test Suites: X passed`, `Tests: Y passed`.

- [ ] **Step 5: Commit**

```bash
git add src/bot/commands/newbeers-build.ts src/bot/commands/newbeers-build.test.ts
git commit -m "$(cat <<'EOF'
feat(newbeers): pub disambiguation by address in pubQuery

Extract filterPubsByQuery: name substring match first (unique → done),
then word-by-word on (name + address) as tiebreaker for duplicates or
address-only fallback when no name matches. Allows 'pinta nowogrodzka'
to narrow two same-named pubs to the one on Nowogrodzka.
EOF
)"
```

Expected: commit hash printed, `nothing to commit` on follow-up `git status`.

---

## Self-Review

**Spec coverage:**
- Unique name-match → step 3, test 1 ✓
- 2 name-matches, no disambiguating word → test 2 ✓
- 2 name-matches + address word → tests 3 & 4 ✓
- Address-only fallback → test 5 ✓
- Unknown query → test 6 + `pub_not_found` in step 3 implementation ✓
- `NewbeersResult` unchanged → `buildNewbeersMessage` return type not touched ✓
- `BeerGroup` unchanged → `newbeers-format.ts` not touched ✓
- Uncommitted draft discarded → Task 1 ✓

**Placeholder scan:** Немає TBD/TODO, всі кроки мають повний код. ✓

**Type consistency:**
- `filterPubsByQuery` визначена в Task 3 Step 1, імпортована в тестах в Task 2 Step 1 ✓
- `PubRow` — тип з `src/storage/pubs.ts`, використовується як параметр `filterPubsByQuery` ✓
- Fixtures в тестах відповідають структурі `PubRow` (`id, slug, name, address, lat, lon`) ✓
