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
