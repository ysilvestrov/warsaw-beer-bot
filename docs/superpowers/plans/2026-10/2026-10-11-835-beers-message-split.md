# #835 — `/beers` Message Split & Display Style Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/beers` answers for every pub by sending its tap list in as many messages as it needs, and a beer description that a pub typed into the style field is never printed as a style in `/beers`, `/newbeers` or `/route`.

**Architecture:** Two pure modules — `display-style` (is this text a description; which style to print) and `message-split` (pack lines into ≤ 4096-character messages; send them in order). The tap query additionally returns the catalogue style; the three commands pick the style to print through one function. Parser, DB contents, matcher and style filter are untouched.

**Tech Stack:** Node.js, TypeScript, Telegraf, better-sqlite3, Vitest.

**Spec:** `docs/superpowers/specs/2026-10/2026-10-11-835-beers-message-split-design.md` — read it first; where this plan and the code disagree, **the code wins and you report the disagreement**.

## Global Constraints

- Message limit: **4096**, counted on the text **with markup** (`string.length`, UTF-16 units — the unit Telegram counts).
- Description rule: text has a sentence break (`\p{L}{3,}[.!?]\s+\p{Lu}`) **or** is longer than **120** code points.
- `taps.style` in the DB, the ontap parser, the matcher and `domain/filters.ts` are **not** changed. Filters keep reading the raw `style`.
- Tests run only through `npm test -- <args>` (never bare `vitest`). **Every task ends with the full gate:** `npm test && npm run typecheck`.
- Test quality (CLAUDE.md): exact asserts, no `if`/early `return` in a test, no tautologies, expected values are literals — never recomputed with production logic.
- Each new test is mutation-proven in the step that says so: break the named line, see the named test go red, restore.
- No extension change, no changelog line, no `[deploy:hold]`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Structure

| File | Responsibility |
|---|---|
| `src/domain/display-style.ts` (new) | `isDescription`, `displayStyle` — pure |
| `src/domain/display-style.test.ts` (new) | their tests |
| `src/bot/commands/message-split.ts` (new) | `TELEGRAM_MESSAGE_LIMIT`, `splitMessage`, `sendEach` — pure / injected sender |
| `src/bot/commands/message-split.test.ts` (new) | their tests |
| `src/storage/snapshots.ts` | `catalog_style` in `TapWithBeer` + query |
| `src/bot/commands/beers-build.ts`, `beers.ts` | `ok` result carries `messages: string[]`; handler sends each |
| `src/bot/commands/newbeers-build.ts` | new exported `candidateFromTap` (one mapping tap → candidate, used twice) |
| `src/bot/commands/route.ts` | uses `candidateFromTap` |
| `spec.md` | three sentences |

Tasks 1 and 2 are small by the CLAUDE.md test (full code given, ≤ 2 files, no decision) — the controller does them inline and names them in the review package of Task 3.

---

### Task 1: `display-style` — description vs style

**Files:**
- Create: `src/domain/display-style.ts`
- Test: `src/domain/display-style.test.ts`

**Interfaces:**
- Produces: `isDescription(style: string): boolean`; `displayStyle(tapStyle: string | null, catalogStyle: string | null): string | null`; `STYLE_MAX_LENGTH = 120`.

- [ ] **Step 1: Write the failing test** — `src/domain/display-style.test.ts`

```ts
import { displayStyle, isDescription } from './display-style';

// Verbatim from prod `taps.style` (White Crow, 2026-09-28 … 2026-10-11): the six texts that broke /beers.
const LIVE_DESCRIPTIONS = [
  "It is a special edition of our La Tomatina Originale brewed for La Tomatina Day 2026 together with our Tomato-mates from Ziemia Obiecana. Cheers",
  "Dessert-Inspired Cream Ale / Milkshake Ale. Brewed with malted barley and oats, enriched with lactose, vanilla, dulce de leche, and biscuit extracts. Creamy and silky, with rich caramel and vanilla sweetness, soft biscuit notes, and a luscious, full-bodied mouthfeel. Smooth, indulgent, and decadently drinkable like a dessert in a glass.",
  "Seria, w której stawiamy na chmielowe eksperymenty. Ekstrakt chmielu Sabro® DynaBoost™ to magiczny składnik, który trafia do piwa na etapie whirlpoola. Pozwala wzmocnić jego chmielowy charakter. A series in which we focus on hop experiments. Sabro® DynaBoost™ hop extract is a magical ingredient added to the beer during the whirlpool stage. It enhances the beer's hop character.",
  "Seria, w której stawiamy na chmielowe eksperymenty. Przed Wami mętne, podwójne IPA, w którym prym wiedzie czysta lupulina chmielu Krush®. To oznacza podwójną dawkę aromatów owoców tropikalnych i cytrusów. A series in which we focus on hop experiments. Here is a hazy Double IPA where the pure lupulin of the Krush® hop takes center stage. This means a double dose of tropical fruit and citrus aromas.",
  "Ahhhh the old country. Where the grass is green and the pints are cream. The first Garage nitro stout is a proper cream pot. Brewed with a simple grist and a good dose of traditional drum roasted barley as is only proper. But we have made a few tweaks to give this a slight biscuit character to compliment that beautiful dark chocolatey, coffee roast flavour. This is a Garage bar exclusive and one of the few places that we know of where you will get a nitro pour in Barcelona. So come in, sit down by a pretend fireplace and getting slurping on this sexy pint!",
  "The days are getting shorter and cooler so it's time to embrace comforting, easy drinking malty beers. The malty goodness is brought to you by high quality Maris Otter malt and some fine English caramel malts that were fermented on a guest yeast strain that is more well known for IPAs but the fruity apricot esters that it bring fit so well here. A moderate hopping with a newer American variety brings complimentary notes of apricot, orange and tangerine. While some of these ingredients are not necessarily true to style, the overall impression of this beer is very much what one would expect form a Best Bitter.",
];

// Verbatim from prod: real styles that look closest to a description.
const LIVE_STYLES = [
  'Sour Ale w. Cherry & Blueberry',
  'Catharina Sour w. Peach Mango Calamansi Passionfruit',
  'Ice Cream Sour w. Lingonberry, Blueberry, Raspberry, Cranberry, Cinnamon, Vanilla & Maple Syrup',
  'Kwaśne Ale z 10 owocami agrest wiśnia jagoda jagoda kamczacka aronia mango marakuja ananas malina czerwona porzeczka',
  'Blend of young and aged lambics with cherries and bourbon vanilla.',
  'Peated Imperial Stout /peated whisky oak chips, sea salt & vanilla /',
  'IPA',
];

describe('isDescription', () => {
  test.each(LIVE_DESCRIPTIONS)('live description %# is a description', (text) => {
    expect(isDescription(text)).toBe(true);
  });

  test.each(LIVE_STYLES)('live style is not a description: %s', (text) => {
    expect(isDescription(text)).toBe(false);
  });

  test('a short text with a sentence break is a description (length alone would not catch it)', () => {
    expect(isDescription('Session IPA. Brewed with Citra hops')).toBe(true);
  });

  test('a sentence may end with ! or ?', () => {
    expect(isDescription('Fresh batch! Now on tap')).toBe(true);
    expect(isDescription('Thirsty? Try this one')).toBe(true);
  });

  test('a two-letter abbreviation before the period is not a sentence end', () => {
    expect(isDescription('Stout nr. Two')).toBe(false);
  });

  test('a period followed by a lowercase letter is not a sentence break', () => {
    expect(isDescription('Pale Ale approx. five hops')).toBe(false);
  });

  test('120 code points without a sentence break is a style; 121 is a description', () => {
    expect(isDescription('a'.repeat(120))).toBe(false);
    expect(isDescription('a'.repeat(121))).toBe(true);
  });

  test('length is counted in code points, not UTF-16 units', () => {
    expect(isDescription('😀'.repeat(120))).toBe(false);
    expect(isDescription('😀'.repeat(121))).toBe(true);
  });

  test('empty string is not a description', () => {
    expect(isDescription('')).toBe(false);
  });
});

describe('displayStyle', () => {
  const description = LIVE_DESCRIPTIONS[4];

  test('description + catalogue style → catalogue style', () => {
    expect(displayStyle(description, 'Stout - Irish Dry')).toBe('Stout - Irish Dry');
  });

  test('description + no catalogue style → null', () => {
    expect(displayStyle(description, null)).toBeNull();
  });

  test('plain style + catalogue style → the pub’s own style', () => {
    expect(displayStyle('NEIPA /Riwaka Cryo, Nelson Sauvin & Citra', 'IPA - New England / Hazy'))
      .toBe('NEIPA /Riwaka Cryo, Nelson Sauvin & Citra');
  });

  test('no tap style + catalogue style → null (the catalogue is not a general fallback)', () => {
    expect(displayStyle(null, 'IPA - American')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it — expect failure**

Run: `npm test -- src/domain/display-style.test.ts`
Expected: FAIL — cannot resolve `./display-style`.

- [ ] **Step 3: Implement** — `src/domain/display-style.ts`

```ts
// #835: a pub sometimes types a whole beer description into ontap's subtitle, which the parser stores
// as the tap's style. Measured on all 940 distinct `taps.style` values in prod (2026-10-11): both rules
// below catch 6 of 6 descriptions and 0 of 934 styles. The naive "period + space + letter" hits six
// real styles through the abbreviation "w." — hence three letters before the period and an uppercase
// letter after it. This decides only what is PRINTED: the DB, the matcher and the style filter keep
// reading the raw field.

/** Longest real style seen is 116 code points, shortest description 144; 120 is a choice, not a measurement. */
export const STYLE_MAX_LENGTH = 120;

const SENTENCE_BREAK = /\p{L}{3,}[.!?]\s+\p{Lu}/u;

export function isDescription(style: string): boolean {
  return SENTENCE_BREAK.test(style) || [...style].length > STYLE_MAX_LENGTH;
}

/** The style to print for a tap: the pub's own, unless it is a description — then the catalogue's, if any. */
export function displayStyle(tapStyle: string | null, catalogStyle: string | null): string | null {
  if (tapStyle === null) return null;
  return isDescription(tapStyle) ? catalogStyle : tapStyle;
}
```

- [ ] **Step 4: Run it — expect pass**

Run: `npm test -- src/domain/display-style.test.ts`
Expected: PASS, 24 tests.

- [ ] **Step 5: Mutation-prove both rules**

1. Replace `SENTENCE_BREAK.test(style) || ` with nothing → `a short text with a sentence break…` and `a sentence may end with ! or ?` must FAIL. Restore.
2. Replace `> STYLE_MAX_LENGTH` with `> 9999` → `120 code points…` and `length is counted in code points…` must FAIL. Restore.
3. Replace `[...style].length` with `style.length` → `length is counted in code points…` must FAIL. Restore.

If a named test stays green, the test is wrong — fix the test, not the list.

- [ ] **Step 6: Full gate and commit**

Run: `npm test && npm run typecheck` — both green.

```bash
git add src/domain/display-style.ts src/domain/display-style.test.ts
git commit -m "feat(#835): displayStyle — a description in the tap's style field is not a style

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `message-split` — pack lines into messages, send in order

**Files:**
- Create: `src/bot/commands/message-split.ts`
- Test: `src/bot/commands/message-split.test.ts`

**Interfaces:**
- Produces: `TELEGRAM_MESSAGE_LIMIT = 4096`; `splitMessage(head: string[], lines: string[], limit?: number): string[]`; `sendEach(messages: string[], send: (message: string) => Promise<unknown>): Promise<void>`.

- [ ] **Step 1: Write the failing test** — `src/bot/commands/message-split.test.ts`

```ts
import { sendEach, splitMessage, TELEGRAM_MESSAGE_LIMIT } from './message-split';

describe('splitMessage', () => {
  test('the default limit is Telegram’s 4096', () => {
    expect(TELEGRAM_MESSAGE_LIMIT).toBe(4096);
  });

  test('nothing to send → no messages', () => {
    expect(splitMessage([], [], 10)).toEqual([]);
  });

  test('a head and no lines → one message with the head alone', () => {
    expect(splitMessage(['HEAD'], [], 10)).toEqual(['HEAD']);
  });

  test('exactly at the limit → one message; one character over → two', () => {
    expect(splitMessage(['HEAD'], ['aaaa'], 9)).toEqual(['HEAD\naaaa']);
    expect(splitMessage(['HEAD'], ['aaaa'], 8)).toEqual(['HEAD', 'aaaa']);
  });

  test('the head is in the first message only; lines keep their order', () => {
    expect(splitMessage(['H'], ['aaa', 'bbb', 'ccc'], 5)).toEqual(['H\naaa', 'bbb', 'ccc']);
  });

  test('each message is filled as far as it goes', () => {
    expect(splitMessage(['H'], ['aaa', 'bbb', 'ccc'], 7)).toEqual(['H\naaa', 'bbb\nccc']);
  });

  test('a head element may itself contain a newline and is never split', () => {
    expect(splitMessage(['H1\nH2'], ['aaa'], 6)).toEqual(['H1\nH2', 'aaa']);
  });

  test('a line longer than the limit loses its markup and is cut to the limit with an ellipsis', () => {
    const long = `<b>${'x'.repeat(20)}</b>`;
    expect(splitMessage([], ['ok', long, 'end'], 10)).toEqual(['ok', 'xxxxxxxxx…', 'end']);
  });

  test('a line that fits once its markup is removed is sent whole, without an ellipsis', () => {
    expect(splitMessage([], ['<b><i>abc</i></b>'], 10)).toEqual(['abc']);
  });

  test('the cut never leaves half an HTML entity', () => {
    expect(splitMessage([], ['xxxxxxx&amp;yy'], 10)).toEqual(['xxxxxxx…']);
  });

  test('the cut never leaves half a surrogate pair', () => {
    expect(splitMessage([], ['ab😀😀'], 4)).toEqual(['ab…']);
  });
});

describe('sendEach', () => {
  test('sends every message, in order, one after another', async () => {
    const log: string[] = [];
    const send = async (message: string): Promise<void> => {
      log.push(`start ${message}`);
      await Promise.resolve();
      log.push(`end ${message}`);
    };
    await sendEach(['a', 'b'], send);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b']);
  });

  test('no messages → nothing is sent', async () => {
    const sent: string[] = [];
    await sendEach([], async (message) => { sent.push(message); });
    expect(sent).toEqual([]);
  });

  test('a failed message stops the rest and the error reaches the caller', async () => {
    const sent: string[] = [];
    const send = async (message: string): Promise<void> => {
      sent.push(message);
      if (message === 'b') throw new Error('400: Bad Request');
    };
    await expect(sendEach(['a', 'b', 'c'], send)).rejects.toThrow('400: Bad Request');
    expect(sent).toEqual(['a', 'b']);
  });
});
```

(The `if` in the last test lives in the **stub sender**, not in the test's path of assertions — the test still has one deterministic path.)

- [ ] **Step 2: Run it — expect failure**

Run: `npm test -- src/bot/commands/message-split.test.ts`
Expected: FAIL — cannot resolve `./message-split`.

- [ ] **Step 3: Implement** — `src/bot/commands/message-split.ts`

```ts
// #835: Telegram rejects a message over 4096 characters outright, and a rejected reply is silence.
// /beers promises ALL taps of a pub, so its list is split across messages, never truncated
// (fitMessage in fest-format.ts truncates — a different promise).
//
// The limit is applied to the text WITH markup. Telegram counts after parsing entities, which only
// removes tags and collapses &amp;-style entities, so the marked-up length is an upper bound and no
// HTML parsing of our own is needed. Measured on the two rejected replies: 5389 → 4283, 7579 → 4793.
export const TELEGRAM_MESSAGE_LIMIT = 4096;

// A single line over the limit cannot be sent whole in any split. Drop its markup (a tag may open
// before the cut and close after it) and cut; never leave half a surrogate pair or half an entity.
function clip(line: string, limit: number): string {
  if (line.length <= limit) return line;
  const plain = line.replace(/<[^>]*>/g, '');
  if (plain.length <= limit) return plain;
  const cut = plain.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, '').replace(/&[^;\s]*$/, '');
  return `${cut}…`;
}

/**
 * Packs head + lines into messages of at most `limit` characters, breaking only between elements.
 * The head is part of the first message. Order is preserved; nothing is dropped.
 */
export function splitMessage(head: string[], lines: string[], limit = TELEGRAM_MESSAGE_LIMIT): string[] {
  const messages: string[] = [];
  let current: string | null = null;
  for (const element of [...head, ...lines]) {
    const line = clip(element, limit);
    if (current === null) {
      current = line;
    } else if (current.length + 1 + line.length <= limit) {
      current = `${current}\n${line}`;
    } else {
      messages.push(current);
      current = line;
    }
  }
  if (current !== null) messages.push(current);
  return messages;
}

/** Sends the messages one after another; the first failure stops the rest and propagates. */
export async function sendEach(
  messages: string[],
  send: (message: string) => Promise<unknown>,
): Promise<void> {
  for (const message of messages) await send(message);
}
```

- [ ] **Step 4: Run it — expect pass**

Run: `npm test -- src/bot/commands/message-split.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Mutation-prove**

1. `<= limit` in `splitMessage` → `< limit`: `exactly at the limit…` must FAIL. Restore.
2. `current.length + 1 + line.length` → `current.length + line.length`: `exactly at the limit…` (the `8` case) must FAIL. Restore.
3. Remove `.replace(/&[^;\s]*$/, '')`: `…half an HTML entity` must FAIL. Restore.
4. Remove `.replace(/[\uD800-\uDBFF]$/, '')`: `…half a surrogate pair` must FAIL. Restore.
5. In `sendEach`, replace the loop with `await Promise.all(messages.map(send));`: `sends every message, in order…` and `a failed message stops the rest…` must FAIL. Restore.

- [ ] **Step 6: Full gate and commit**

Run: `npm test && npm run typecheck` — both green.

```bash
git add src/bot/commands/message-split.ts src/bot/commands/message-split.test.ts
git commit -m "feat(#835): splitMessage — pack lines into messages under Telegram's limit, send in order

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `/beers` — catalogue style in the tap query, several messages, style for display

**Files:**
- Modify: `src/storage/snapshots.ts` (`TapWithBeer`, `tapsForSnapshotWithBeer`)
- Modify: `src/bot/commands/beers-build.ts`
- Modify: `src/bot/commands/beers.ts`
- Test: `src/storage/snapshots.test.ts`, `src/bot/commands/beers-build.test.ts`

**Interfaces:**
- Consumes: `displayStyle(tapStyle, catalogStyle)` from `src/domain/display-style.ts`; `splitMessage(head, lines)`, `sendEach(messages, send)` from `src/bot/commands/message-split.ts`.
- Produces: `TapWithBeer.catalog_style: string | null`; `BeersResult` arm `{ kind: 'ok'; messages: string[] }` (the `html` field is gone).

- [ ] **Step 1: Failing test for the query** — append inside `describe('tapsForSnapshotWithBeer', …)` in `src/storage/snapshots.test.ts`. Reuse that file's existing `fresh()`/seed imports (`seedBeer`, `upsertMatch`, `upsertPub`, `createSnapshot`, `insertTaps`); add an import only if the file lacks one.

```ts
  test('#835 catalog_style is the linked beer’s style; the tap’s own style is untouched', () => {
    const db = fresh();
    const pubId = upsertPub(db, { slug: 'p', name: 'Kufel', address: null, lat: null, lon: null, city: 'warszawa' });
    const snapId = createSnapshot(db, pubId, '2026-10-11T12:00:00Z');
    const beerId = seedBeer(db, {
      untappd_id: 7001, name: 'The Quiet Man', brewery: 'Garage Beer Co.', style: 'Stout - Irish Dry',
      normalized_name: 'the quiet man', normalized_brewery: 'garage beer',
    });
    upsertMatch(db, 'Garage Beer Co.', 'The Quiet Man', beerId, 1.0);
    insertTaps(db, snapId, [
      { tap_number: 1, beer_ref: 'The Quiet Man', brewery_ref: 'Garage Beer Co.',
        abv: null, ibu: null, style: 'Ahhhh the old country. Where the grass is green.', u_rating: null },
      { tap_number: 2, beer_ref: 'Unlinked', brewery_ref: 'Nobody',
        abv: null, ibu: null, style: 'IPA', u_rating: null },
    ]);
    expect(tapsForSnapshotWithBeer(db, snapId).map((r) => [r.tap_number, r.style, r.catalog_style])).toEqual([
      [1, 'Ahhhh the old country. Where the grass is green.', 'Stout - Irish Dry'],
      [2, 'IPA', null],
    ]);
    db.close();
  });
```

Run: `npm test -- src/storage/snapshots.test.ts` → FAIL (`catalog_style` is `undefined`, and typecheck would reject the property).

- [ ] **Step 2: Implement the query change** — `src/storage/snapshots.ts`

In `TapWithBeer` add the field (keep the existing comments):

```ts
export interface TapWithBeer extends TapRow {
  beer_id: number | null;
  untappd_id: number | null;
  // #835: the linked beer's Untappd style. `style` stays the pub's own text; which one is PRINTED is
  // decided by displayStyle (a pub may type a whole description into the style field).
  catalog_style: string | null;
```

In the `SELECT` of `tapsForSnapshotWithBeer`, after `b.untappd_id AS untappd_id` add:

```sql
      b.untappd_id AS untappd_id,
      b.style AS catalog_style
```

Run: `npm test -- src/storage/snapshots.test.ts` → PASS.

- [ ] **Step 3: Move the existing `/beers` tests to the new result shape** — `src/bot/commands/beers-build.test.ts`

Every existing test produces one message. Mechanical edit, 14 places:
- `out.html` → `out.messages[0]` (12 occurrences, lines ~122–265);
- `html: expect.stringContaining(` → `messages: [expect.stringContaining(` and close the bracket: `)] })` (2 occurrences, lines ~41 and ~287).

Do not touch what those tests assert.

- [ ] **Step 4: Add the failing `/beers` tests** — append to `src/bot/commands/beers-build.test.ts`

```ts
describe('buildBeersMessage — #835 long lists and descriptions', () => {
  // 78 linked taps: the size of the pub that broke /beers (Piw Paw, Foksal). The expected split below
  // was computed independently of the implementation (greedy pack at 4096 over these exact strings).
  function seedBigPub(db: ReturnType<typeof fresh>) {
    const pubId = upsertPub(db, { slug: 'big', name: 'Wielokran Testowy', address: null, lat: null, lon: null, city: 'warszawa' });
    const snap = createSnapshot(db, pubId, '2026-10-11T12:00:00Z');
    const numbers = Array.from({ length: 78 }, (_, i) => i + 1);
    for (const n of numbers) {
      const beerId = seedBeer(db, {
        untappd_id: 1000 + n, name: `Piwo Numer ${n}`, brewery: 'Browar Testowy',
        normalized_name: `piwo numer ${n}`, normalized_brewery: 'browar testowy',
      });
      upsertMatch(db, 'Browar Testowy', `Piwo Numer ${n}`, beerId, 1.0);
    }
    insertTaps(db, snap, numbers.map((n) => ({
      tap_number: n, beer_ref: `Piwo Numer ${n}`, brewery_ref: 'Browar Testowy',
      abv: null, ibu: null, style: null, u_rating: null,
    })));
    return numbers;
  }

  const tapNumbers = (message: string): number[] =>
    message.split('\n').filter((line) => /^\d+ • /.test(line)).map((line) => Number(line.split(' ')[0]));

  test('78 taps arrive as two messages, the first filled to 4094 of 4096', () => {
    const db = fresh();
    seedBigPub(db);
    const out = base(db, 'wielokran');
    expect(out).toMatchObject({ kind: 'ok' });
    const { messages } = out as { messages: string[] };
    expect(messages.map((m) => m.length)).toEqual([4094, 3491]);
    db.close();
  });

  test('the header is in the first message only and no tap is lost or reordered', () => {
    const db = fresh();
    const numbers = seedBigPub(db);
    const { messages } = base(db, 'wielokran') as { messages: string[] };
    expect(messages[0].split('\n').slice(0, 2)).toEqual(['🍺 <b>Wielokran Testowy</b>', 'Кранів: 78']);
    expect(messages[1].startsWith('43 • ')).toBe(true);
    expect(messages.flatMap(tapNumbers)).toEqual(numbers);
    db.close();
  });

  test('every message is self-contained HTML: tags open and close inside it', () => {
    const db = fresh();
    seedBigPub(db);
    const { messages } = base(db, 'wielokran') as { messages: string[] };
    const count = (text: string, token: string): number => text.split(token).length - 1;
    expect(messages.map((m) => [count(m, '<a '), count(m, '</a>'), count(m, '<b>'), count(m, '</b>')])).toEqual([
      [42, 42, 43, 43],
      [36, 36, 36, 36],
    ]);
    db.close();
  });

  test('a description on a linked tap is replaced by the catalogue style', () => {
    const db = fresh();
    const pubId = upsertPub(db, { slug: 'p', name: 'Kufel', address: null, lat: null, lon: null, city: 'warszawa' });
    const snap = createSnapshot(db, pubId, '2026-10-11T12:00:00Z');
    const beerId = seedBeer(db, {
      untappd_id: 7001, name: 'The Quiet Man', brewery: 'Garage Beer Co.', style: 'Stout - Irish Dry',
      normalized_name: 'the quiet man', normalized_brewery: 'garage beer',
    });
    upsertMatch(db, 'Garage Beer Co.', 'The Quiet Man', beerId, 1.0);
    insertTaps(db, snap, [{ tap_number: 9, beer_ref: 'The Quiet Man', brewery_ref: 'Garage Beer Co.',
      abv: null, ibu: null, style: 'Ahhhh the old country. Where the grass is green and the pints are cream.', u_rating: null }]);
    const { messages } = base(db, 'kufel') as { messages: string[] };
    expect(messages[0].split('\n')[2]).toBe(
      '9 • <a href="https://untappd.com/beer/7001"><b>Garage Beer Co. The Quiet Man</b></a> • Stout - Irish Dry • — • — • ⭐',
    );
    db.close();
  });

  test('a description on an unlinked tap leaves the style out', () => {
    const db = fresh();
    const pubId = upsertPub(db, { slug: 'p', name: 'Kufel', address: null, lat: null, lon: null, city: 'warszawa' });
    const snap = createSnapshot(db, pubId, '2026-10-11T12:00:00Z');
    insertTaps(db, snap, [{ tap_number: 9, beer_ref: 'The Quiet Man', brewery_ref: 'Garage Beer Co.',
      abv: null, ibu: null, style: 'Ahhhh the old country. Where the grass is green and the pints are cream.', u_rating: null }]);
    const { messages } = base(db, 'kufel') as { messages: string[] };
    expect(messages[0].split('\n')[2]).toBe('9 • <b>Garage Beer Co. The Quiet Man</b> • — • — • ⚪');
    db.close();
  });

  test('a plain style is printed as the pub wrote it, even when the catalogue has another', () => {
    const db = fresh();
    const pubId = upsertPub(db, { slug: 'p', name: 'Kufel', address: null, lat: null, lon: null, city: 'warszawa' });
    const snap = createSnapshot(db, pubId, '2026-10-11T12:00:00Z');
    const beerId = seedBeer(db, {
      untappd_id: 7002, name: 'Hop Cloud', brewery: 'Browar Testowy', style: 'IPA - New England / Hazy',
      normalized_name: 'hop cloud', normalized_brewery: 'browar testowy',
    });
    upsertMatch(db, 'Browar Testowy', 'Hop Cloud', beerId, 1.0);
    insertTaps(db, snap, [{ tap_number: 3, beer_ref: 'Hop Cloud', brewery_ref: 'Browar Testowy',
      abv: null, ibu: null, style: 'NEIPA /Riwaka Cryo', u_rating: null }]);
    const { messages } = base(db, 'kufel') as { messages: string[] };
    expect(messages[0].split('\n')[2]).toBe(
      '3 • <a href="https://untappd.com/beer/7002"><b>Browar Testowy Hop Cloud</b></a> • NEIPA /Riwaka Cryo • — • — • ⭐',
    );
    db.close();
  });
});
```

Run: `npm test -- src/bot/commands/beers-build.test.ts` → FAIL (`messages` is undefined).

**If the two literal lengths `[4094, 3491]` or the first tap `43` come out different**, do not edit the numbers to match: print the first message and compare it with the format in `spec.md` §`/beers` — the difference is either a real defect or a fact about `escapeHtml`/the header this plan got wrong, and it must be reported.

- [ ] **Step 5: Implement the builder** — `src/bot/commands/beers-build.ts`

Add imports:

```ts
import { displayStyle } from '../../domain/display-style';
import { splitMessage } from './message-split';
```

Change the result type:

```ts
export type BeersResult =
  | { kind: 'ok'; messages: string[] }
```

In the `taps.map`, replace the returned line:

```ts
    const nameHtml = beerNameHtml(display, tap.untappd_id);
    // #835: a description typed into the style field is not printed as a style.
    const style = displayStyle(tap.style, tap.catalog_style);
    return (
      `${fmtTapNum(tap.tap_number)} • ${nameHtml}${fmtStyle(style)}` +
      ` • ${fmtAbv(tap.abv)} • ${fmtRating(tap.u_rating)} • ${icon}`
    );
```

Replace the final `return`:

```ts
  // #835: /beers shows ALL taps, so a list over Telegram's limit is split, never truncated.
  return { kind: 'ok', messages: splitMessage([header], lines) };
```

- [ ] **Step 6: Implement the handler** — `src/bot/commands/beers.ts`

Add `import { sendEach } from './message-split';` and replace the `ok` arm:

```ts
    case 'ok':
      await sendEach(result.messages, (message) => ctx.replyWithHTML(message));
      return;
```

- [ ] **Step 7: Run — expect pass**

Run: `npm test -- src/bot/commands/beers-build.test.ts src/storage/snapshots.test.ts`
Expected: PASS.

- [ ] **Step 8: Mutation-prove**

1. `beers-build.ts`: `displayStyle(tap.style, tap.catalog_style)` → `tap.style`: both `a description on …` tests must FAIL. Restore.
2. `beers-build.ts`: `displayStyle(tap.style, tap.catalog_style)` → `tap.catalog_style`: `a plain style is printed as the pub wrote it…` must FAIL. Restore.
3. `beers-build.ts`: `splitMessage([header], lines)` → `[[header, ...lines].join('\n')]`: `78 taps arrive as two messages…` must FAIL. Restore.
4. `snapshots.ts`: `b.style AS catalog_style` → `NULL AS catalog_style`: the `#835 catalog_style…` test must FAIL. Restore.

- [ ] **Step 9: Full gate and commit**

Run: `npm test && npm run typecheck` — both green. (Typecheck is what proves no other reader of `BeersResult.html` exists.)

```bash
git add src/storage/snapshots.ts src/storage/snapshots.test.ts src/bot/commands/beers-build.ts src/bot/commands/beers-build.test.ts src/bot/commands/beers.ts
git commit -m "fix(#835): /beers sends a long tap list as several messages instead of one Telegram rejects

A pub with 78 taps (or 25 taps with descriptions typed into the style field) produced one
message over 4096 characters; sendMessage returned 400 and the user got nothing. The list is
now packed into messages at line boundaries, and a description in the style field is replaced
by the catalogue style of the linked beer.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `/newbeers` and `/route` print the display style; `spec.md`

**Files:**
- Modify: `src/bot/commands/newbeers-build.ts` (new exported `candidateFromTap`, used in its own loop)
- Modify: `src/bot/commands/route.ts` (uses `candidateFromTap`)
- Modify: `spec.md`
- Test: `src/bot/commands/newbeers-build.test.ts`

**Interfaces:**
- Consumes: `displayStyle` (Task 1); `TapWithBeer.catalog_style` (Task 3).
- Produces: `candidateFromTap(tap: TapWithBeer, pubName: string): CandidateTap` exported from `src/bot/commands/newbeers-build.ts`.

Both commands build a `CandidateTap` from a tap with the same nine-field literal (`newbeers-build.ts` ~lines 92–102, `route.ts` ~lines 92–101). The style rule would otherwise have to be written twice, and the copy in `route.ts` sits inside a command handler no test reaches — so the mapping becomes one exported function.

- [ ] **Step 1: Failing test** — append to `src/bot/commands/newbeers-build.test.ts`; extend the import to `import { buildNewbeersMessage, candidateFromTap, filterPubsByQuery } from './newbeers-build';`

```ts
describe('candidateFromTap (#835)', () => {
  const tap = {
    id: 1, snapshot_id: 1, tap_number: 9, beer_ref: 'The Quiet Man', brewery_ref: 'Garage Beer Co.',
    abv: 4.5, ibu: null, u_rating: 3.9, beer_id: 55, untappd_id: 7001,
    style: 'Ahhhh the old country. Where the grass is green and the pints are cream.',
    catalog_style: 'Stout - Irish Dry',
  };

  test('maps every field; a description gives way to the catalogue style', () => {
    expect(candidateFromTap(tap, 'White Crow')).toEqual({
      beer_id: 55,
      untappd_id: 7001,
      display: 'Garage Beer Co. The Quiet Man',
      brewery_norm: 'garage beer',
      name_norm: 'the quiet man',
      style: 'Stout - Irish Dry',
      abv: 4.5,
      rating: 3.9,
      pub_name: 'White Crow',
    });
  });

  test('a plain style is kept as the pub wrote it', () => {
    expect(candidateFromTap({ ...tap, style: 'Dry Stout (nitro)' }, 'White Crow').style).toBe('Dry Stout (nitro)');
  });

  test('a description without a catalogue style gives no style', () => {
    expect(candidateFromTap({ ...tap, catalog_style: null }, 'White Crow').style).toBeNull();
  });

  test('a tap without a brewery shows the bare beer name', () => {
    expect(candidateFromTap({ ...tap, brewery_ref: null }, 'White Crow')).toMatchObject({
      display: 'The Quiet Man', brewery_norm: '',
    });
  });
});

test('#835 /newbeers prints the catalogue style for a tap whose style field holds a description', () => {
  const db = fresh();
  const pubId = upsertPub(db, { slug: 'wc', name: 'White Crow', address: null, lat: null, lon: null, city: 'warszawa' });
  const snap = createSnapshot(db, pubId, '2026-10-11T12:00:00Z');
  const beerId = seedBeer(db, {
    untappd_id: 7001, name: 'The Quiet Man', brewery: 'Garage Beer Co.', style: 'Stout - Irish Dry',
    abv: 4.5, rating_global: 3.9, normalized_name: 'the quiet man', normalized_brewery: 'garage beer',
  });
  upsertMatch(db, 'Garage Beer Co.', 'The Quiet Man', beerId, 1.0);
  insertTaps(db, snap, [{ tap_number: 9, beer_ref: 'The Quiet Man', brewery_ref: 'Garage Beer Co.',
    abv: 4.5, ibu: null, style: 'Ahhhh the old country. Where the grass is green and the pints are cream.', u_rating: 3.9 }]);
  ensureProfile(db, 1);
  const out = buildNewbeersMessage({ db, telegramId: 1, locale: 'uk', t: createTranslator('uk'), city: 'warszawa' });
  expect(out).toMatchObject({ kind: 'ok', html: expect.stringContaining('</b></a> • Stout - Irish Dry  ') });
  expect(out).toMatchObject({ kind: 'ok', html: expect.not.stringContaining('Ahhhh') });
  db.close();
});
```

Before relying on the last test, read how the neighbouring tests in this file call `buildNewbeersMessage` (argument names, whether `ensureProfile` is needed) and mirror them exactly — **the file's existing calls beat this snippet**.

Run: `npm test -- src/bot/commands/newbeers-build.test.ts` → FAIL (`candidateFromTap` is not exported).

- [ ] **Step 2: Implement** — `src/bot/commands/newbeers-build.ts`

Add imports (`TapWithBeer` type alongside the existing snapshots import; `displayStyle`):

```ts
import { latestSnapshotsPerPub, tapsForSnapshotWithBeer, type TapWithBeer } from '../../storage/snapshots';
import { displayStyle } from '../../domain/display-style';
```

`CandidateTap` is already imported in this file from `./newbeers-format`; if it is imported as a value-less type list, add it there. Add the function above `buildNewbeersMessage`:

```ts
/**
 * One tap as a /newbeers and /route candidate. #835: the printed style goes through displayStyle —
 * a description typed into the style field is replaced by the catalogue style. Filtering happens
 * BEFORE this, on the raw tap, and is not affected.
 */
export function candidateFromTap(tap: TapWithBeer, pubName: string): CandidateTap {
  return {
    beer_id: tap.beer_id,
    untappd_id: tap.untappd_id,
    display: tap.brewery_ref ? `${tap.brewery_ref} ${tap.beer_ref}`.trim() : tap.beer_ref,
    brewery_norm: normalizeBrewery(tap.brewery_ref ?? ''),
    name_norm: normalizeName(tap.beer_ref),
    style: displayStyle(tap.style, tap.catalog_style),
    abv: tap.abv,
    rating: tap.u_rating,
    pub_name: pubName,
  };
}
```

In the loop, replace the `const display = …` line and the whole `candidates.push({ … })` literal with:

```ts
      candidates.push(candidateFromTap(tap, pub.name));
```

- [ ] **Step 3: Use it in `/route`** — `src/bot/commands/route.ts`

Add `import { candidateFromTap } from './newbeers-build';`. Replace the `good.map((t) => ({ … }))` literal inside `interestingByPub.set(` with:

```ts
    interestingByPub.set(pub.id, good.map((t) => candidateFromTap(t, pub.name)));
```

Then remove imports that became unused in `route.ts` and `newbeers-build.ts` (`normalizeBrewery`/`normalizeName` stay in `newbeers-build.ts`; in `route.ts` drop them only if nothing else uses them — `npm run typecheck` plus the linter decide, not this sentence).

- [ ] **Step 4: Run — expect pass**

Run: `npm test -- src/bot/commands/newbeers-build.test.ts src/bot/commands/route.test.ts src/bot/commands/route-format.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation-prove**

1. `candidateFromTap`: `displayStyle(tap.style, tap.catalog_style)` → `tap.style`: `maps every field…`, `a description without a catalogue style…` and the `#835 /newbeers prints…` test must FAIL. Restore.
2. `candidateFromTap`: → `tap.catalog_style`: `a plain style is kept…` must FAIL. Restore.

- [ ] **Step 6: `spec.md`**

(a) In «`/newbeers [частина назви паба]`», step 5, replace `+ відомий стиль inline (невідомий пропускається)` with:

```
+ відомий стиль inline (невідомий пропускається; опис замість стилю — див. «Стиль для показу» нижче)
```

(b) In «`/beers <паб>`», after the sentence ending `лишається компактним (`{№} • N/A`) без рейтингів і статусу.` add a new paragraph:

```
**Довгий список (#835).** Telegram відхиляє повідомлення, довше за 4096 символів, тож список, який не
вміщається в одне, надсилається кількома: рядки пакуються по черзі, розрив лише на межі рядка, заголовок
стоїть у першому. Довжина рахується за текстом разом із розміткою — це верхня межа того, що рахує Telegram.
Рядок, довший за ліміт сам по собі, надсилається без розмітки, обрізаним до ліміту з `…`.

**Стиль для показу (#835).** Паб інколи пише в поле стилю цілий опис пива. Описом вважається текст, у якому
після закінченого речення починається нове (слово від трьох літер, `.`/`!`/`?`, пробіл, велика літера), або
довший за 120 символів (`src/domain/display-style.ts`). Замість опису `/beers`, `/newbeers` і `/route`
показують стиль із каталогу Untappd, якщо кран злінкований, інакше стиль пропускається. Звичайний стиль
показується так, як його написав паб. У БД, матчері й фільтрі стилів поле лишається сирим.
```

(c) In «`/route [N]`», the line `У списку пив кожного паба відомий стиль показується inline після назви;` — append to that sentence's paragraph: ` Опис замість стилю — див. «Стиль для показу» в розділі `/beers`.`

Read the three places before editing: if the surrounding text differs from the quotes above, keep its wording and insert the new sentences at the same logical spot.

- [ ] **Step 7: Full gate and commit**

Run: `npm test && npm run typecheck` — both green.

```bash
git add src/bot/commands/newbeers-build.ts src/bot/commands/newbeers-build.test.ts src/bot/commands/route.ts spec.md
git commit -m "fix(#835): /newbeers and /route print the catalogue style when the tap's style field is a description

Both commands built a candidate from a tap with the same literal; it is now one function,
candidateFromTap, so the display-style rule is written once and tested.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## After the last task

1. End-to-end review of the whole branch (Tasks 1–2 were inline — name them in the dispatch).
2. `git fetch origin main && git rebase origin/main`, then the full gate again.
3. `npm run cross-review -- --reviewer codex` **in the background**; verify every finding.
4. Push, open the PR (no `[deploy:hold]`); body carries the `Cross-review:` marker and `Closes #835`.
5. **Live probe after the merge-deploy** (spec §4, row 1) — the only proof that Telegram accepts the result:
   - `/beers piw paw` (78 taps) → two messages arrive; `/beers white crow` → one message, six lines show a catalogue style instead of a paragraph;
   - `journalctl -u warsaw-beer-bot --since '<deploy time>' -o cat | grep -c 'message is too long'` → `0`.
   Only the user can send the commands; ask for it and read the journal afterwards.
