import { Composer, Markup } from 'telegraf';
import type { BotContext } from '../index';
import type { HostPatchRead } from '../../domain/status/types';
import type { RebootKind } from '../../jobs/reboot-request';

// #469 stage 3: the admin's three buttons under the reboot alert. Each carries the since of the
// reboot it was sent for, so an old message's buttons do nothing. The bot only ASKS: root acts,
// and only while a reboot is pending (spec C24) — so the replies say «запит надіслано».
export type RebootAction = RebootKind | 'snooze';
export type PressOutcome = 'request' | 'snooze' | 'stale' | 'unknown';

export const PRESS_TEXT = {
  not_admin: 'Лише для адміністратора.',
  requested_now: 'Запит надіслано: перезавантаження зараз.',
  requested_0400: 'Запит надіслано: перезавантаження о 04:00 (Варшава).',
  snoozed: 'Нагадаю через 3 дні.',
  stale: 'Застаріло: ця кнопка від іншого перезавантаження, або воно вже не потрібне.',
  unknown: 'Стан хоста зараз невідомий — спробуй пізніше.',
  failed: 'Не вдалося записати запит — дивись лог бота.',
} as const;

const CALLBACK = /^rb:(now|0400|snooze):(\d{1,12})$/;

export function rebootKeyboard(since: number) {
  return Markup.inlineKeyboard([[
    Markup.button.callback('Зараз', `rb:now:${since}`),
    Markup.button.callback('О 04:00', `rb:0400:${since}`),
    Markup.button.callback('Нагадати через 3 дні', `rb:snooze:${since}`),
  ]]);
}

export function currentRebootSince(read: HostPatchRead): number | null | 'unknown' {
  if (read.kind !== 'ok') return 'unknown';
  return read.facts.rebootRequired?.since ?? null;
}

export function decideRebootPress(p: { action: RebootAction; since: number; current: number | null | 'unknown' }): PressOutcome {
  if (p.action === 'snooze') return 'snooze';
  if (p.current === 'unknown') return 'unknown';
  return p.current === p.since ? 'request' : 'stale';
}

export interface RebootCommandDeps {
  now: () => Date;
  currentSince: (now: Date) => number | null | 'unknown';
  request: (kind: RebootKind, now: Date) => void;
  snooze: (since: number, now: Date) => boolean;
  log: { error: (obj: object, msg: string) => void };
}

export function createRebootCommand(deps: RebootCommandDeps): Composer<BotContext> {
  const composer = new Composer<BotContext>();
  composer.action(CALLBACK, async (ctx) => {
    if (ctx.chat?.type !== 'private' || String(ctx.from.id) !== ctx.deps.env.ADMIN_TELEGRAM_ID) {
      await ctx.answerCbQuery(PRESS_TEXT.not_admin);
      return;
    }
    const action = ctx.match[1] as RebootAction;
    const since = Number(ctx.match[2]);
    const now = deps.now();
    const outcome = decideRebootPress({ action, since, current: action === 'snooze' ? 'unknown' : deps.currentSince(now) });
    if (outcome === 'unknown') {
      await ctx.answerCbQuery(PRESS_TEXT.unknown);
      return;
    }
    let text: string;
    if (outcome === 'request') {
      const kind = action as RebootKind;
      try {
        deps.request(kind, now);
      } catch (e) {
        deps.log.error({ err: e }, 'reboot request write failed');
        await ctx.answerCbQuery(PRESS_TEXT.failed);
        return;
      }
      text = kind === 'now' ? PRESS_TEXT.requested_now : PRESS_TEXT.requested_0400;
    } else if (outcome === 'snooze') {
      text = deps.snooze(since, now) ? PRESS_TEXT.snoozed : PRESS_TEXT.stale;
    } else {
      text = PRESS_TEXT.stale;
    }
    await ctx.answerCbQuery(text);
    await ctx.editMessageReplyMarkup(undefined);
    await ctx.reply(text);
  });
  return composer;
}
