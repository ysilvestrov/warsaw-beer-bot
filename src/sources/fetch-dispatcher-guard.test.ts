import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

const SRC = resolve(__dirname, '..');

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      out.push(...tsFiles(p));
      continue;
    }
    if (!name.endsWith('.ts')) continue;
    if (name.endsWith('.test.ts')) continue;
    out.push(p);
  }
  return out;
}

// #581: guard дивиться на КОД, а не на прозу. `src/sources/fetch-like.ts` — типовий модуль:
// він і згадує `dispatcher` (поле `dispatcher?: Dispatcher`), і кілька разів називає `fetch`
// у своїх українських коментарях, але не робить жодного запиту — і не повинен імпортувати
// `fetch` з undici. Тому перед перевіркою прибираємо коментарі (і блокові, і рядкові) й
// дивимось лише на те, що лишилось у виконуваному коді.
function stripComments(text: string): string {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, '');
  // Рядковий коментар `//` — крім випадку, коли він є частиною URL-схеми (`https://…`), де
  // `//` йде одразу за двокрапкою. Навмисно грубо: `//` усередині рядкового літералу поза
  // URL-схемою міг би над-стерти хвіст рядка, але це ризик хибного НЕГАТИВУ в екзотичному
  // файлі, а не хибного позитиву на реальних модулях цього проєкту.
  out = out.replace(/(^|[^:])\/\/.*$/gm, '$1');
  return out;
}

// Ідентифікатор `fetch` як окреме слово — не підрядок (`fetchImpl`, `undiciFetch` не рахуються).
const FETCH_IDENTIFIER = /\bfetch\b/;
// Сам імпорт `{ fetch as … } from 'undici'` теж містить \bfetch\b — і це саме та річ, яку
// правило вимагає, тож вона є винятком, а не порушенням.
const IMPORTS_UNDICI_FETCH = /import\s*\{[^}]*\bfetch\b[^}]*\}\s*from\s*'undici'/;

// #581: цей guard існує тому, що інтеграційні тести з Task 1-3 знають лише два модулі, які вже
// віддають `dispatcher`. Третій, доданий завтра, віддав би його глобальному `fetch` і проїхав би
// зеленим — рівно так, як проїхав бамп undici ^7→^8, що поклав чотири шляхи на 14 діб.
test('every module that gives fetch a dispatcher takes fetch from undici', () => {
  const offenders: string[] = [];
  for (const file of tsFiles(SRC)) {
    const code = stripComments(readFileSync(file, 'utf8'));
    if (!code.includes('dispatcher')) continue;
    if (!FETCH_IDENTIFIER.test(code)) continue;
    if (IMPORTS_UNDICI_FETCH.test(code)) continue;
    offenders.push(relative(SRC, file));
  }
  expect(offenders).toEqual([]);
});
