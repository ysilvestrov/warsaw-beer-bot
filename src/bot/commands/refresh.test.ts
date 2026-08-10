import pino from 'pino';
import { Context } from 'telegraf';
import {
  createRefreshCommand,
  makeThrottledProgress,
  runRefreshPipeline,
  resolveRefreshScope,
  checkAndStampCooldown,
  cooldownWindowFor,
} from './refresh';
import type { Translator } from '../../i18n/types';
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { upsertPub } from '../../storage/pubs';
import { CITIES } from '../../domain/cities';
import type { BotContext } from '../index';
import type { NewbeersDeps, NewbeersResult } from './newbeers-build';
import { ensureProfile, setUserCity } from '../../storage/user_profiles';

describe('makeThrottledProgress', () => {
  test('drops non-forced calls within interval', async () => {
    let now = 1000;
    const calls: string[] = [];
    const send = async (t: string) => {
      calls.push(t);
    };
    const notify = makeThrottledProgress(send, 100, () => now);

    await notify('a');
    await notify('b');
    expect(calls).toEqual(['a']);

    now += 50;
    await notify('c');
    expect(calls).toEqual(['a']);

    now += 60;
    await notify('d');
    expect(calls).toEqual(['a', 'd']);
  });

  test('forced calls bypass throttle', async () => {
    let now = 1000;
    const calls: string[] = [];
    const send = async (t: string) => {
      calls.push(t);
    };
    const notify = makeThrottledProgress(send, 100000, () => now);

    await notify('start', { force: true });
    await notify('mid');
    await notify('end', { force: true });
    expect(calls).toEqual(['start', 'end']);
  });

  test('dedupes consecutive identical messages', async () => {
    let now = 1000;
    const calls: string[] = [];
    const send = async (t: string) => {
      calls.push(t);
    };
    const notify = makeThrottledProgress(send, 0, () => now);

    await notify('a');
    await notify('a');
    await notify('a', { force: true });
    expect(calls).toEqual(['a']);
  });
});

const silentLog = pino({ level: 'silent' });

// `(key: string) => key` is structurally wider than Translator's keyof-Messages
// constraint, so a double-cast is the smallest type ceremony to use it as a
// stub here. The pipeline only forwards `t(...)` calls verbatim, so identity
// is enough.
const tStub = ((key: string) => key) as unknown as Translator;

interface NotifyCall {
  text: string;
  force: boolean;
}

function makeNotify() {
  const calls: NotifyCall[] = [];
  const notify = async (text: string, opts?: { force?: boolean }) => {
    calls.push({ text, force: opts?.force === true });
  };
  return { notify, calls };
}

describe('runRefreshPipeline', () => {
  test('on success: refresh.done emitted BEFORE postRun runs', async () => {
    const { notify, calls } = makeNotify();
    const events: string[] = [];
    // Tag the notify so we can sequence notify against run/postRun.
    const wrappedNotify = async (text: string, opts?: { force?: boolean }) => {
      events.push(`notify:${text}`);
      await notify(text, opts);
    };
    const run = async () => {
      events.push('run');
    };
    const postRun = async () => {
      events.push('postRun');
    };

    await runRefreshPipeline({ run, notify: wrappedNotify, t: tStub, log: silentLog, postRun });

    expect(events).toEqual(['run', 'notify:refresh.done', 'postRun']);
    expect(calls).toEqual([{ text: 'refresh.done', force: true }]);
  });

  test('on success without postRun: only refresh.done is emitted', async () => {
    const { notify, calls } = makeNotify();
    const run = async () => {};

    await runRefreshPipeline({ run, notify, t: tStub, log: silentLog });

    expect(calls).toEqual([{ text: 'refresh.done', force: true }]);
  });

  test('postRun throws: error is logged, pipeline still resolves, no refresh.failed', async () => {
    const { notify, calls } = makeNotify();
    const errors: unknown[] = [];
    const log = {
      error: (obj: unknown) => errors.push(obj),
      info: () => {},
      warn: () => {},
      debug: () => {},
      trace: () => {},
      fatal: () => {},
    } as unknown as typeof silentLog;
    const run = async () => {};
    const postRun = async () => {
      throw new Error('boom');
    };

    await expect(
      runRefreshPipeline({ run, notify, t: tStub, log, postRun }),
    ).resolves.toBeUndefined();

    expect(calls).toEqual([{ text: 'refresh.done', force: true }]);
    expect(errors).toHaveLength(1);
  });

  test('run rejects: emits refresh.failed and never calls postRun', async () => {
    const { notify, calls } = makeNotify();
    let postRunCalled = false;
    const run = async () => {
      throw new Error('scrape died');
    };
    const postRun = async () => {
      postRunCalled = true;
    };

    await runRefreshPipeline({ run, notify, t: tStub, log: silentLog, postRun });

    expect(postRunCalled).toBe(false);
    expect(calls).toEqual([{ text: 'refresh.failed', force: true }]);
  });
});

function dbWithPubs() {
  const db = openDb(':memory:');
  migrate(db);
  const bracka = upsertPub(db, { slug: 'bracka', name: 'Bracka 4', address: 'Bracka 4', lat: null, lon: null, city: 'warszawa' });
  const krakowBracka = upsertPub(db, { slug: 'krakow-house', name: 'Krakow Bracka House', address: 'Bracka 10', lat: null, lon: null, city: 'krakow' });
  const meta = upsertPub(db, { slug: 'meta-pub', name: 'Meta Pub', address: 'Nowy Świat 1', lat: null, lon: null, city: 'warszawa' });
  const piwpaw = upsertPub(db, { slug: 'piwpaw', name: 'PiwPaw', address: 'Foksal 16', lat: null, lon: null, city: 'warszawa' });
  const piwpawBis = upsertPub(db, { slug: 'piwpaw-bis', name: 'PiwPaw Bis', address: 'Żurawia 32', lat: null, lon: null, city: 'warszawa' });
  return { db, ids: { bracka, krakowBracka, meta, piwpaw, piwpawBis } };
}

describe('resolveRefreshScope', () => {
  const warsaw = CITIES.find((city) => city.slug === 'warszawa')!;
  const krakow = CITIES.find((city) => city.slug === 'krakow')!;

  test('admin empty argument runs all cities and all profiles with the full cooldown', () => {
    const { db } = dbWithPubs();
    expect(resolveRefreshScope({
      db, telegramId: 42, adminTelegramId: '42', city: 'warszawa', arg: '   ',
    })).toEqual({ kind: 'run', cooldown: 'all' });
  });

  test('admin me runs the active city and caller profile with the full cooldown', () => {
    const { db } = dbWithPubs();
    expect(resolveRefreshScope({
      db, telegramId: 42, adminTelegramId: '42', city: 'warszawa', arg: 'me',
    })).toEqual({
      kind: 'run',
      cooldown: 'all',
      cities: [warsaw],
      telegramIds: new Set([42]),
    });
  });

  test('admin query searches another city by address and all profiles with the full cooldown', () => {
    const { db, ids } = dbWithPubs();
    expect(resolveRefreshScope({
      db, telegramId: 42, adminTelegramId: '42', city: 'warszawa', arg: 'Bracka 10',
    })).toEqual({
      kind: 'run',
      cooldown: 'all',
      cities: [krakow],
      pubSlugs: new Set(['krakow-house']),
      pubIds: new Set([ids.krakowBracka]),
    });
  });

  test('admin query includes matching pubs and represented cities across city boundaries', () => {
    const { db, ids } = dbWithPubs();
    expect(resolveRefreshScope({
      db, telegramId: 42, adminTelegramId: '42', city: 'warszawa', arg: 'bracka',
    })).toEqual({
      kind: 'run',
      cooldown: 'all',
      cities: [warsaw, krakow],
      pubSlugs: new Set(['bracka', 'krakow-house']),
      pubIds: new Set([ids.bracka, ids.krakowBracka]),
    });
  });

  test('non-admin empty argument runs the active city and caller profile with the full cooldown', () => {
    const { db } = dbWithPubs();
    expect(resolveRefreshScope({
      db, telegramId: 7, adminTelegramId: '42', city: 'krakow', arg: '',
    })).toEqual({
      kind: 'run',
      cooldown: 'all',
      cities: [krakow],
      telegramIds: new Set([7]),
    });
  });

  test('non-admin query stays in the active city with caller profile and scoped cooldown', () => {
    const { db, ids } = dbWithPubs();
    expect(resolveRefreshScope({
      db, telegramId: 7, adminTelegramId: '42', city: 'warszawa', arg: 'bracka',
    })).toEqual({
      kind: 'run',
      cooldown: 'scoped',
      cities: [warsaw],
      pubSlugs: new Set(['bracka']),
      pubIds: new Set([ids.bracka]),
      telegramIds: new Set([7]),
    });
  });

  test.each(['me', ' ME ', 'Me'])('admin %j is the reserved caller scope', (arg) => {
    const { db } = dbWithPubs();
    expect(resolveRefreshScope({
      db, telegramId: 42, adminTelegramId: '42', city: 'warszawa', arg,
    })).toEqual({
      kind: 'run',
      cooldown: 'all',
      cities: [warsaw],
      telegramIds: new Set([42]),
    });
  });

  test('non-admin me remains an ordinary pub query', () => {
    const { db, ids } = dbWithPubs();
    expect(resolveRefreshScope({
      db, telegramId: 7, adminTelegramId: '42', city: 'warszawa', arg: 'me',
    })).toEqual({
      kind: 'run',
      cooldown: 'scoped',
      cities: [warsaw],
      pubSlugs: new Set(['meta-pub']),
      pubIds: new Set([ids.meta]),
      telegramIds: new Set([7]),
    });
  });

  test('non-admin query excludes an address match outside the active city', () => {
    const { db } = dbWithPubs();
    expect(resolveRefreshScope({
      db, telegramId: 7, adminTelegramId: '42', city: 'warszawa', arg: 'Bracka 10',
    })).toEqual({
      kind: 'pub_not_found',
      query: 'Bracka 10',
    });
  });

  test('query includes every matching pub', () => {
    const { db, ids } = dbWithPubs();
    expect(resolveRefreshScope({
      db, telegramId: 7, city: 'warszawa', arg: 'piwpaw',
    })).toEqual({
      kind: 'run',
      cooldown: 'scoped',
      cities: [warsaw],
      pubSlugs: new Set(['piwpaw', 'piwpaw-bis']),
      pubIds: new Set([ids.piwpaw, ids.piwpawBis]),
      telegramIds: new Set([7]),
    });
  });

  test('not-found query is trimmed before returning', () => {
    const { db } = dbWithPubs();
    expect(resolveRefreshScope({
      db, telegramId: 7, adminTelegramId: '42', city: 'warszawa', arg: '  nonexistent  ',
    })).toEqual({
      kind: 'pub_not_found',
      query: 'nonexistent',
    });
  });
});

function refreshContext(args: {
  db: ReturnType<typeof openDb>;
  telegramId: number;
  adminTelegramId?: string;
  text: string;
  sent: Array<{ text: string; extra?: unknown }>;
}): BotContext {
  const from = { id: args.telegramId, is_bot: false, first_name: 'Test' };
  const chat = { id: args.telegramId, type: 'private' as const };
  const message = {
    message_id: 1,
    date: 0,
    chat,
    from,
    text: args.text,
    entities: [{ offset: 0, length: 8, type: 'bot_command' as const }],
  };
  const telegram = {
    editMessageText: async () => true,
    sendMessage: async (_chatId: number, text: string, extra?: unknown) => {
      args.sent.push({ text, extra });
      return { message_id: 3 };
    },
  };
  const ctx = new Context(
    { update_id: 1, message } as unknown as ConstructorParameters<typeof Context>[0],
    telegram as unknown as ConstructorParameters<typeof Context>[1],
    { username: 'test_bot' } as unknown as ConstructorParameters<typeof Context>[2],
  ) as BotContext;
  Object.assign(ctx, {
    deps: {
      db: args.db,
      env: { ADMIN_TELEGRAM_ID: args.adminTelegramId },
      log: silentLog,
    },
    locale: 'en',
    t: tStub,
    reply: async () => ({ message_id: 2 }),
  });
  return ctx;
}

describe('createRefreshCommand scope forwarding', () => {
  const warsaw = CITIES.find((city) => city.slug === 'warszawa')!;
  const krakow = CITIES.find((city) => city.slug === 'krakow')!;

  test.each([
    {
      name: 'non-admin city refresh',
      telegramId: 1001,
      adminTelegramId: '42',
      city: 'krakow',
      text: '/refresh',
      expected: { cities: [krakow], pubSlugs: undefined, telegramIds: new Set([1001]) },
    },
    {
      name: 'admin global refresh',
      telegramId: 1002,
      adminTelegramId: '1002',
      city: 'warszawa',
      text: '/refresh',
      expected: { cities: undefined, pubSlugs: undefined, telegramIds: undefined },
    },
    {
      name: 'admin me refresh',
      telegramId: 1003,
      adminTelegramId: '1003',
      city: 'krakow',
      text: '/refresh me',
      expected: { cities: [krakow], pubSlugs: undefined, telegramIds: new Set([1003]) },
    },
  ])('$name forwards the run scope without a follow-up', async (testCase) => {
    const { db } = dbWithPubs();
    ensureProfile(db, testCase.telegramId);
    setUserCity(db, testCase.telegramId, testCase.city);
    const sent: Array<{ text: string; extra?: unknown }> = [];
    let runOptions: unknown;
    let postRunCalled = false;
    const command = createRefreshCommand(
      async (_notify, opts) => { runOptions = opts; },
      () => {
        postRunCalled = true;
        return { kind: 'empty' };
      },
    );

    await command.middleware()(refreshContext({
      db,
      telegramId: testCase.telegramId,
      adminTelegramId: testCase.adminTelegramId,
      text: testCase.text,
      sent,
    }), async () => {});

    await vi.waitFor(() => expect(runOptions).toEqual(testCase.expected));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(postRunCalled).toBe(false);
    expect(sent).toEqual([]);
  });

  test.each([
    {
      name: 'HTML result',
      result: { kind: 'ok', html: '<b>fresh</b>' } as NewbeersResult,
      expected: { text: '<b>fresh</b>', extra: { parse_mode: 'HTML' } },
    },
    {
      name: 'empty result',
      result: { kind: 'empty' } as NewbeersResult,
      expected: { text: 'newbeers.empty', extra: undefined },
    },
  ])('query follow-up sends the $name for the exact matched pub IDs', async ({ result, expected }) => {
    const { db, ids } = dbWithPubs();
    const telegramId = result.kind === 'ok' ? 1101 : 1102;
    ensureProfile(db, telegramId);
    setUserCity(db, telegramId, 'warszawa');
    const sent: Array<{ text: string; extra?: unknown }> = [];
    let runOptions: unknown;
    let postRunDeps: NewbeersDeps | undefined;
    const command = createRefreshCommand(
      async (_notify, opts) => { runOptions = opts; },
      (deps) => {
        postRunDeps = deps;
        return result;
      },
    );

    await command.middleware()(refreshContext({
      db,
      telegramId,
      adminTelegramId: String(telegramId),
      text: '/refresh Bracka 10',
      sent,
    }), async () => {});

    await vi.waitFor(() => expect(postRunDeps).toBeDefined());
    expect(runOptions).toEqual({
      cities: [krakow],
      pubSlugs: new Set(['krakow-house']),
      telegramIds: undefined,
    });
    expect(postRunDeps).toMatchObject({
      db,
      telegramId,
      city: 'warszawa',
      pubIds: new Set([ids.krakowBracka]),
    });
    expect(postRunDeps).not.toHaveProperty('pubQuery');
    expect(sent).toEqual([expected]);
  });

  test('pub_not_found starts no work and does not consume the caller scoped cooldown', async () => {
    const { db } = dbWithPubs();
    const telegramId = 1201;
    const sent: Array<{ text: string; extra?: unknown }> = [];
    let runCalls = 0;
    let postRunCalls = 0;
    const command = createRefreshCommand(
      async () => { runCalls += 1; },
      () => {
        postRunCalls += 1;
        return { kind: 'empty' };
      },
    );

    await command.middleware()(refreshContext({
      db,
      telegramId,
      adminTelegramId: '42',
      text: '/refresh missing-pub',
      sent,
    }), async () => {});

    expect(runCalls).toBe(0);
    expect(postRunCalls).toBe(0);

    await command.middleware()(refreshContext({
      db,
      telegramId,
      adminTelegramId: '42',
      text: '/refresh meta',
      sent,
    }), async () => {});

    await vi.waitFor(() => {
      expect(runCalls).toBe(1);
      expect(postRunCalls).toBe(1);
    });
  });
});

describe('cooldownWindowFor', () => {
  test('full refresh → 5 minutes', () => {
    expect(cooldownWindowFor('all')).toBe(5 * 60 * 1000);
  });
  test('scoped refresh → 30 seconds', () => {
    expect(cooldownWindowFor('scoped')).toBe(30 * 1000);
  });
});

describe('checkAndStampCooldown', () => {
  test('first call allowed and stamps the map', () => {
    const map = new Map<number, number>();
    expect(checkAndStampCooldown(map, 42, 1000, 5000)).toBe(true);
    expect(map.get(42)).toBe(5000);
  });

  test('second call within the window is blocked', () => {
    const map = new Map<number, number>();
    checkAndStampCooldown(map, 42, 1000, 5000);
    expect(checkAndStampCooldown(map, 42, 1000, 5500)).toBe(false);
  });

  test('call after the window is allowed again', () => {
    const map = new Map<number, number>();
    checkAndStampCooldown(map, 42, 1000, 5000);
    expect(checkAndStampCooldown(map, 42, 1000, 6001)).toBe(true);
  });

  test('separate maps do not interfere', () => {
    const full = new Map<number, number>();
    const scoped = new Map<number, number>();
    checkAndStampCooldown(full, 42, 300000, 1000);
    // full is now in cooldown, but the scoped map is untouched
    expect(checkAndStampCooldown(scoped, 42, 30000, 1000)).toBe(true);
  });
});
