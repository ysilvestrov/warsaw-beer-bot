// #836: a /route result may need several messages (#835's splitMessage). The first replaces the
// «шукаю маршрут…» status message, the rest follow in order, and the Maps button sits under the
// LAST one so it is next to where the person finishes reading. The first failure stops the rest
// and propagates — the caller tells the person and records it.
export interface RouteResultIo<K = unknown> {
  edit: (text: string, keyboard?: K) => Promise<unknown>;
  send: (text: string, keyboard?: K) => Promise<unknown>;
  keyboard?: K;
}

export async function sendRouteResult<K>(messages: string[], io: RouteResultIo<K>): Promise<void> {
  for (const [i, message] of messages.entries()) {
    const deliver = i === 0 ? io.edit : io.send;
    await deliver(message, i === messages.length - 1 ? io.keyboard : undefined);
  }
}
