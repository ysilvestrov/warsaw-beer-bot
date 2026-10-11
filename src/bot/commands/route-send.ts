// #836: a /route result may need several messages (#835's splitMessage). The first replaces the
// «шукаю маршрут…» status message, the rest follow in order, and the Maps button sits under the
// LAST one so it is next to where the person finishes reading. The first failure stops the rest
// and propagates — the caller tells the person and records it.
import type pino from 'pino';
import type { DB } from '../../storage/db';
import { noteFailure } from '../handler-failure';

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

/**
 * The detached part of /route, as one unit that can be tested: any failure of `work` — building
 * the route or delivering it — is logged, recorded as `/route` and told to the person.
 * Never rejects: it runs detached, so a rejection would be an unhandled one.
 */
export async function runRouteWork(
  deps: { db: DB; log: pino.Logger },
  work: () => Promise<void>,
  notifyFailed: () => Promise<void>,
): Promise<void> {
  try {
    await work();
  } catch (e) {
    deps.log.error({ err: e }, 'route failed');
    noteFailure(deps, '/route', e);
    await notifyFailed().catch((err) => deps.log.warn({ err }, 'route failure notice not sent'));
  }
}
