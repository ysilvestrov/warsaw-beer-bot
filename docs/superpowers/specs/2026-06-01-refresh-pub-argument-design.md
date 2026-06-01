# `/refresh [паб]` — скоупнутий refresh за назвою паба

**Дата:** 2026-06-01
**Статус:** дизайн затверджено, чекає плану

## Мотивація

`/refresh` зараз робить повний обхід: ~50 пабів на ontap.pl (~3 хв) плюс
скрейп Untappd-профілю. Якщо тебе цікавить один конкретний паб, доводиться
чекати весь обхід. Додаємо опційний аргумент — назву паба — щоб рефрешити
**тільки** його крани й одразу показати свіжий `/newbeers` по ньому.

Розпізнавання аргументу — **таке саме, як у `/newbeers <паб>`**: спершу за
назвою, з уточненням за адресою (через спільний `filterPubsByQuery`).

## Поведінка

### `/refresh` (без аргументу) — без змін
- Повний обхід ontap.pl по всіх пабах + скрейп Untappd-профілю.
- Кулдаун 5 хв на користувача.
- Після успіху — `buildNewbeersMessage` без аргументу; результат `empty`
  **мовчазний** (щоб не спамити після успішного, але «нічого нового» рефрешу).

### `/refresh <паб>` — нова гілка
1. **Матчинг паба** через спільний `filterPubsByQuery` (name-first,
   address-tiebreaker — той самий, що в `/newbeers`). Семантика «як у
   newbeers»: якщо запит підходить **кільком** пабам — рефрешимо **всі**
   (на відміну від `/beers`, який відмовляється вгадувати й показує
   кандидатів).
2. Якщо збігів **0** → одразу `newbeers.pub_not_found` (з підказкою `/pubs`).
   Refresh **не стартує**, кулдаун **не витрачається**.
3. Інакше — **ontap-only** обхід лише матчених пабів (1 HTTP на індекс +
   по 1 на кожен матчений паб). Untappd-скрейп **пропускається** (had-список
   не залежить від паба; оновлюється щодоби о 03:00 UTC + при повному
   `/refresh`).
4. Після успіху — `buildNewbeersMessage` з **тим самим аргументом**. Для
   скоупнутого виклику `empty` **НЕ мовчазний** — користувач спитав про
   конкретний паб, мовчанка збивала б з пантелику.

## Кулдаун

Дві **незалежні** мапи `telegramId → timestamp`:
- `lastFullCall` — 5 хв (`COOLDOWN_MS`), для `/refresh` без аргументу.
- `lastScopedCall` — 30 с (`SCOPED_COOLDOWN_MS`), для `/refresh <паб>`.

Незалежність навмисна: скоупнутий refresh дешевий, тож повний refresh не
блокує серію скоупнутих і навпаки. Перевіряється лише мапа, що відповідає
формі виклику.

## Зміни в коді

### 1. `src/jobs/refresh-ontap.ts`
Додати optional `pubSlugs?: Set<string>` у `Deps`. Якщо задано —
відфільтрувати індекс одразу після парсингу:

```ts
let indexPubs = parseWarsawIndex(indexHtml);
if (deps.pubSlugs) {
  indexPubs = indexPubs.filter((ip) => deps.pubSlugs!.has(ip.slug));
}
```

Лічильники прогресу (`0/${indexPubs.length}`, `${i}/${indexPubs.length}`)
автоматично рахують від відфільтрованої довжини. Без параметра поведінка
повністю незмінна.

### 2. `src/bot/commands/refresh.ts`
Нова **чиста** хелпер-функція (юніт-тестована, без побічних ефектів):

```ts
export type RefreshScope =
  | { kind: 'all' }
  | { kind: 'scoped'; slugs: Set<string>; query: string }
  | { kind: 'pub_not_found'; query: string };

export function resolveRefreshScope(db: DB, arg: string): RefreshScope;
```

- Порожній `arg` → `{ kind: 'all' }`.
- Інакше: `filterPubsByQuery(listPubs(db), arg)`. Порожньо →
  `{ kind: 'pub_not_found', query: arg }`. Є збіги → `{ kind: 'scoped',
  slugs: new Set(matched.map(p => p.slug)), query: arg }`.

Команда:
- парсить `arg` так само, як `/newbeers` (`text.split(' ').slice(1).join(' ').trim()`);
- викликає `resolveRefreshScope`;
- `pub_not_found` → `ctx.reply(t('newbeers.pub_not_found', { query }))`, вихід;
- вибирає кулдаун-мапу за `scope.kind` (`all` → `lastFullCall`/5 хв,
  `scoped` → `lastScopedCall`/30 с); якщо в кулдауні — `refresh.cooldown`, вихід;
- запускає `run(notify, scope.kind === 'scoped' ? { pubSlugs: scope.slugs } : undefined)`;
- `postRun`: `buildNewbeersMessage({ ..., pubQuery: scope.kind === 'scoped' ? scope.query : undefined })`;
  показувати `empty`, лише якщо `scope.kind === 'scoped'` (повний — мовчить, як зараз).

### 3. `createRefreshCommand` (той самий файл)
Сигнатура `run` отримує другий аргумент:

```ts
run: (notify: ProgressFn, opts?: { pubSlugs?: Set<string> }) => Promise<void>
```

### 4. `src/index.ts`
Замикання `run` приймає й інтерпретує `opts`:

```ts
async (notify, opts) => {
  await refreshOntap({ db, log, http, geocoder, onProgress: notify,
    lookupEnabled: env.UNTAPPD_LOOKUP_ENABLED, pubSlugs: opts?.pubSlugs });
  if (!opts?.pubSlugs && untappdHttp) {
    await refreshAllUntappd({ db, log, http: untappdHttp, onProgress: notify, notifyAdmin });
  }
}
```

Тобто `pubSlugs` задано → лише ontap для матчених пабів; інакше — повний
пайплайн як зараз.

## i18n

Нових рядків **не потрібно**. Not-found реюзає наявний `newbeers.pub_not_found`
(uk/pl/en уже є). `refresh.starting` / прогрес / `refresh.done` / `refresh.failed`
— без змін.

## Тести (Jest — обовʼязково перед merge)

- **`resolveRefreshScope`**: порожній arg → `all`; arg на один паб → `scoped`
  з одним slug; arg на кілька → `scoped` з усіма slug-ами; arg без збігів →
  `pub_not_found`.
- **`refreshOntap` з `pubSlugs`**: обходить лише матчені slug-и (інші пропущені),
  денумератор прогресу = кількість матчених; без `pubSlugs` — поведінка незмінна.
- **Кулдаун**: дві мапи незалежні — повний у кулдауні не блокує скоупнутий і
  навпаки; повторний виклик тієї ж форми в межах вікна → `cooldown`.
- **postRun**: скоупнутий показує `empty`; повний — мовчить при `empty`.

## Edge cases (задокументувати, не фіксити)

- **Паб на ontap.pl, якого ще немає в БД** (жодного разу не рефрешився): не
  зматчиться запитом (бо `filterPubsByQuery` дивиться в БД) → `pub_not_found`.
  Спершу його «відкриває» повний `/refresh`. Прийнятно.

## Не входить (YAGNI)

- Окремий рядок i18n для refresh-not-found (реюз newbeers).
- `/beers`-стиль «показати кандидатів при кількох збігах» — навмисно
  слідуємо newbeers-семантиці (рефреш усіх матчених).
- Untappd-скрейп у скоупнутому рефреші.
