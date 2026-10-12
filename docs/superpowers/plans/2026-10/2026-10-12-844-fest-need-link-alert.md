# #844 fest need_link alert Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The "link Untappd first" refusal of the team join button is shown only to the person who pressed it.

**Architecture:** One branch of the `fest:j` callback handler answers the callback with an alert instead of posting to the chat. No storage, no new module.

**Tech Stack:** TypeScript, Telegraf, Vitest.

**Spec:** `docs/superpowers/specs/2026-10/2026-10-12-844-fest-need-link-alert-design.md`

## Global Constraints

- Full gate per task: `npm test && npm run typecheck`. Tests run only through `npm test -- <args>`.
- Test quality: exact asserts, no conditionals in tests, literal expected values.
- `spec.md` is updated in the same PR.
- Locale strings are not changed.

---

### Task 1: the refusal is a callback alert

**Files:**
- Modify: `src/bot/commands/fest.ts` (the `fest:j` action)
- Test: `src/bot/commands/fest.wiring.test.ts`
- Modify: `spec.md` (the «Я в команді» sentence in the `/fest` bullet)

- [ ] **Step 1: make the stub record the second argument**

In `setup()` add `extras: unknown[]` next to `answers`, filled by the `answerCbQuery` stub:

```ts
ctx.answerCbQuery = (async (text?: string, extra?: unknown) => { answers.push(text); extras.push(extra); return true; }) as never;
```

and return it from `setup()`.

- [ ] **Step 2: write the failing tests**

```ts
describe('«Я в команді» (fest:j)', () => {
  it('someone without a linked Untappd is told so in an alert only they see, and is not added', async () => {
    const { db, bot, teamId, replies, answers, extras } = setup();
    await bot.handleUpdate(callback(1, 8, `fest:j:${teamId}`) as unknown as Update);
    expect([replies, answers, extras, isTeamMember(db, teamId, 8)]).toEqual([
      [], ['First link Untappd in a private chat with the bot: /link <username>'], [{ show_alert: true }], false,
    ]);
  });

  it('someone with a linked Untappd joins and is announced by name', async () => {
    const { db, bot, teamId, replies, answers } = setup();
    ensureProfile(db, 8);
    setUntappdUsername(db, 8, 'newcomer');
    await bot.handleUpdate(callback(1, 8, `fest:j:${teamId}`) as unknown as Update);
    expect([replies, answers, isTeamMember(db, teamId, 8)]).toEqual([['✅ Test joined the team.'], [undefined], true]);
  });

  it('a member who presses again is told so and nothing is posted', async () => {
    const { bot, teamId, replies, answers, extras } = setup();
    await bot.handleUpdate(callback(1, 7, `fest:j:${teamId}`) as unknown as Update);
    expect([replies, answers, extras]).toEqual([[], ['You are already in the team.'], [undefined]]);
  });

  it('a button of a team that does not exist posts nothing and adds nobody', async () => {
    const { db, bot, teamId, replies, answers } = setup();
    await bot.handleUpdate(callback(1, 8, `fest:j:${teamId + 1}`) as unknown as Update);
    expect([replies, answers, isTeamMember(db, teamId, 8)]).toEqual([[], [undefined], false]);
  });
});
```

Import `isTeamMember` from `../../storage/fest_teams`.

- [ ] **Step 3: run, expect the first test to fail**

Run: `npm test -- src/bot/commands/fest.wiring.test.ts`
Expected: the first test fails (`replies` holds the text, `answers` is `[undefined]`); the other three pass.

- [ ] **Step 4: implement**

```ts
    if (!getProfile(db, ctx.from.id)?.untappd_username) {
      await ctx.answerCbQuery(ctx.t('fest.need_link'), { show_alert: true });
      return;
    }
```

- [ ] **Step 5: `spec.md`**

In the `/fest` bullet: «(вимагає прив'язаний Untappd; відмова — спливним вікном лише тому, хто натиснув, у чат нічого не пишеться)».

- [ ] **Step 6: full gate, commit**

Run: `npm test && npm run typecheck`
