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
