import { describe, expect, it } from 'vitest';
import { Telegraf } from 'telegraf';
import type { Update, UserFromGetMe } from '@telegraf/types';
import type { BotContext } from '../index';
import type { RebootKind } from '../../jobs/reboot-request';
import { createRebootCommand, currentRebootSince, decideRebootPress, rebootKeyboard, PRESS_TEXT } from './reboot';

/** #469 stage 3 periphery. */
const SINCE = 1_791_100_000;
const NOW = new Date(1_791_461_800_000);
const ADMIN = 42;
const BOT_INFO: UserFromGetMe = {
  id: 1, is_bot: true, first_name: 'B', username: 'BeerBot', can_join_groups: true,
  can_read_all_group_messages: false, supports_inline_queries: false,
};

describe('rebootKeyboard', () => {
  it('carries the since in every button, under Telegram’s 64-byte limit', () => {
    const rows = rebootKeyboard(SINCE).reply_markup.inline_keyboard;
    expect(rows).toEqual([[
      { text: 'Зараз', callback_data: `rb:now:${SINCE}`, hide: false },
      { text: 'О 04:00', callback_data: `rb:0400:${SINCE}`, hide: false },
      { text: 'Нагадати через 3 дні', callback_data: `rb:snooze:${SINCE}`, hide: false },
    ]]);
  });
});

describe('currentRebootSince', () => {
  it('an ok summary with a pending reboot gives its since', () => {
    expect(currentRebootSince({ kind: 'ok', facts: { rebootRequired: { since: SINCE, packages: [] } } } as never)).toBe(SINCE);
  });
  it('an ok summary with nothing pending gives null', () => {
    expect(currentRebootSince({ kind: 'ok', facts: { rebootRequired: null } } as never)).toBe(null);
  });
  it('a stale or unavailable summary is unknown', () => {
    expect([currentRebootSince({ kind: 'stale' }), currentRebootSince({ kind: 'unavailable' })]).toEqual(['unknown', 'unknown']);
  });
});

describe('decideRebootPress', () => {
  it('a reboot press for the pending since is a request', () => {
    expect(decideRebootPress({ action: 'now', since: SINCE, current: SINCE })).toBe('request');
  });
  it('a reboot press for another since is stale', () => {
    expect(decideRebootPress({ action: '0400', since: SINCE, current: SINCE + 3600 })).toBe('stale');
  });
  it('a reboot press when nothing is pending is stale', () => {
    expect(decideRebootPress({ action: 'now', since: SINCE, current: null })).toBe('stale');
  });
  it('a reboot press with an unreadable summary is unknown', () => {
    expect(decideRebootPress({ action: 'now', since: SINCE, current: 'unknown' })).toBe('unknown');
  });
  it('a snooze does not consult the summary: its binding is the alert state', () => {
    expect(decideRebootPress({ action: 'snooze', since: SINCE, current: 'unknown' })).toBe('snooze');
  });
});

function callback(updateId: number, from: number, data: string, chatType: 'private' | 'supergroup' = 'private') {
  return { update_id: updateId, callback_query: { id: `cb-${updateId}`, chat_instance: 'x', data,
    from: { id: from, is_bot: false, first_name: 'Test' },
    message: { message_id: 5, date: 1, chat: chatType === 'private'
      ? { id: from, type: 'private' as const, first_name: 'Test' }
      : { id: -100, type: 'supergroup' as const, title: 'G' } } } };
}

function setup(opts: { current?: number | null | 'unknown'; snoozeOk?: boolean; requestThrows?: boolean } = {}) {
  const requests: Array<[RebootKind, number]> = [];
  const snoozes: number[] = [];
  const answers: (string | undefined)[] = [];
  const replies: string[] = [];
  const edits: unknown[] = [];
  const errors: string[] = [];
  const bot = new Telegraf<BotContext>('123456:FAKE');
  bot.botInfo = BOT_INFO;
  bot.use((ctx, next) => {
    ctx.deps = { db: {}, env: { ADMIN_TELEGRAM_ID: String(ADMIN) }, log: {} } as never;
    ctx.answerCbQuery = (async (text?: string) => { answers.push(text); return true; }) as never;
    ctx.reply = (async (m: string) => { replies.push(m); return { message_id: 9 }; }) as never;
    ctx.editMessageReplyMarkup = (async (m: unknown) => { edits.push(m); return true; }) as never;
    return next();
  });
  bot.use(createRebootCommand({
    now: () => NOW,
    currentSince: () => (opts.current === undefined ? SINCE : opts.current),
    request: (kind, now) => {
      if (opts.requestThrows) throw new Error('EACCES');
      requests.push([kind, now.getTime()]);
    },
    snooze: (since) => { snoozes.push(since); return opts.snoozeOk ?? true; },
    log: { error: (_o, msg) => { errors.push(msg); } },
  }));
  return { bot, requests, snoozes, answers, replies, edits, errors };
}

const press = (bot: Telegraf<BotContext>, from: number, data: string, chatType?: 'private' | 'supergroup') =>
  bot.handleUpdate(callback(1, from, data, chatType) as unknown as Update);

describe('createRebootCommand', () => {
  it('«Зараз» for the pending reboot writes a now request, drops the keyboard and says the request was sent', async () => {
    const s = setup();
    await press(s.bot, ADMIN, `rb:now:${SINCE}`);
    expect([s.requests, s.answers, s.replies, s.edits]).toEqual([
      [['now', NOW.getTime()]], [PRESS_TEXT.requested_now], [PRESS_TEXT.requested_now], [undefined],
    ]);
  });

  it('«О 04:00» writes a 0400 request', async () => {
    const s = setup();
    await press(s.bot, ADMIN, `rb:0400:${SINCE}`);
    expect([s.requests, s.replies]).toEqual([[['0400', NOW.getTime()]], [PRESS_TEXT.requested_0400]]);
  });

  it('a non-admin press does nothing but the admins-only toast', async () => {
    const s = setup();
    await press(s.bot, ADMIN + 1, `rb:now:${SINCE}`);
    expect([s.requests, s.snoozes, s.answers, s.replies, s.edits]).toEqual([[], [], [PRESS_TEXT.not_admin], [], []]);
  });

  it('the admin pressing in a group is treated as not-admin', async () => {
    const s = setup();
    await press(s.bot, ADMIN, `rb:now:${SINCE}`, 'supergroup');
    expect([s.requests, s.answers]).toEqual([[], [PRESS_TEXT.not_admin]]);
  });

  it('an old message’s button writes nothing and says it is stale', async () => {
    const s = setup({ current: SINCE + 3600 });
    await press(s.bot, ADMIN, `rb:now:${SINCE}`);
    expect([s.requests, s.answers, s.replies, s.edits]).toEqual([[], [PRESS_TEXT.stale], [PRESS_TEXT.stale], [undefined]]);
  });

  it('an unreadable summary writes nothing and keeps the keyboard for a retry', async () => {
    const s = setup({ current: 'unknown' });
    await press(s.bot, ADMIN, `rb:0400:${SINCE}`);
    expect([s.requests, s.answers, s.replies, s.edits]).toEqual([[], [PRESS_TEXT.unknown], [], []]);
  });

  it('a failed request write is logged, reported, and keeps the keyboard', async () => {
    const s = setup({ requestThrows: true });
    await press(s.bot, ADMIN, `rb:now:${SINCE}`);
    expect([s.errors, s.answers, s.replies, s.edits]).toEqual([['reboot request write failed'], [PRESS_TEXT.failed], [], []]);
  });

  it('«Нагадати через 3 дні» snoozes that since', async () => {
    const s = setup();
    await press(s.bot, ADMIN, `rb:snooze:${SINCE}`);
    expect([s.snoozes, s.requests, s.replies, s.edits]).toEqual([[SINCE], [], [PRESS_TEXT.snoozed], [undefined]]);
  });

  it('a snooze the alert state refuses is stale', async () => {
    const s = setup({ snoozeOk: false });
    await press(s.bot, ADMIN, `rb:snooze:${SINCE}`);
    expect([s.snoozes, s.replies]).toEqual([[SINCE], [PRESS_TEXT.stale]]);
  });

  it('callback data that is not rb:<kind>:<digits> is not handled', async () => {
    const s = setup();
    await press(s.bot, ADMIN, 'rb:reboot:1');
    await press(s.bot, ADMIN, `rb:now:${SINCE}x`);
    expect([s.requests, s.answers]).toEqual([[], []]);
  });
});
