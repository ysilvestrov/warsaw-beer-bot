import { trackProgress, interruptActiveProgress } from './active-progress';
import type { Locale } from '../i18n/types';

type EditCall = { chatId: number; messageId: number; text: string };

function fakeTelegram() {
  const calls: EditCall[] = [];
  const telegram = {
    editMessageText: async (chatId: number, messageId: number, _inline: undefined, text: string) => {
      calls.push({ chatId, messageId, text });
      return true as unknown;
    },
  };
  return { telegram, calls };
}

// Deterministic translator: returns the locale + key so assertions are locale-agnostic.
const fakeTranslator = (locale: Locale) => ((key: string) => `[${locale}]${key}`) as never;

describe('active-progress registry', () => {
  it('appends the interrupt suffix to each active message and clears the map', async () => {
    const h1 = trackProgress(111, 1, 'uk');
    const h2 = trackProgress(222, 2, 'en');
    h1.update('progress one');
    h2.update('progress two');

    const { telegram, calls } = fakeTelegram();
    await interruptActiveProgress(telegram, fakeTranslator);

    expect(calls).toHaveLength(2);
    expect(calls.find((c) => c.chatId === 111)!.text).toBe('progress one\n\n[uk]common.interrupted_by_restart');
    expect(calls.find((c) => c.chatId === 222)!.text).toBe('progress two\n\n[en]common.interrupted_by_restart');

    // Map cleared: a second sweep edits nothing.
    const second = fakeTelegram();
    await interruptActiveProgress(second.telegram, fakeTranslator);
    expect(second.calls).toHaveLength(0);

    h1.release();
    h2.release();
  });

  it('does not edit a released entry', async () => {
    const h = trackProgress(333, 3, 'pl');
    h.update('x');
    h.release();
    const { telegram, calls } = fakeTelegram();
    await interruptActiveProgress(telegram, fakeTranslator);
    expect(calls).toHaveLength(0);
  });

  it('uses the suffix alone when there is no progress text yet', async () => {
    const h = trackProgress(444, 4, 'en');
    const { telegram, calls } = fakeTelegram();
    await interruptActiveProgress(telegram, fakeTranslator);
    expect(calls[0].text).toBe('[en]common.interrupted_by_restart');
    h.release();
  });
});
