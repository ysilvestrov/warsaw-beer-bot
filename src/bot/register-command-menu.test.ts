import { vi } from 'vitest';
import pino from 'pino';
import { registerCommandMenu } from './register-command-menu';

const silent = pino({ level: 'silent' });

test('registers a localized menu per language (uk/pl/en) plus a default scope', async () => {
  const calls: { opts?: { language_code?: string } }[] = [];
  const bot = {
    telegram: {
      setMyCommands: vi.fn(async (_cmds: unknown, opts?: { language_code?: string }) => {
        calls.push({ opts });
      }),
    },
  };
  await registerCommandMenu(bot as never, silent);
  expect(bot.telegram.setMyCommands).toHaveBeenCalledTimes(4);
  expect(calls.slice(0, 3).map((c) => c.opts?.language_code)).toEqual(['uk', 'pl', 'en']);
  expect(calls[3].opts).toBeUndefined(); // default scope: no language_code
});

test('swallows a setMyCommands failure (logs, does not throw)', async () => {
  const bot = {
    telegram: { setMyCommands: vi.fn(async () => { throw new Error('network'); }) },
  };
  await expect(registerCommandMenu(bot as never, silent)).resolves.toBeUndefined();
});
