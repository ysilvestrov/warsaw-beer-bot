import { pickAdapter } from '../sites/registry';
import { runOverlay, type SendMatch, type EnrichOrphans } from './index';
import { observeReRender, type ReRenderOptions } from './rerender';
import { refreshCards } from './refresh';
import { clearKeys } from '../cache/store';
import { isSeen, renderState, type CardState } from './badge';
import { runEnrichment, type OrphanBeer } from './enrich';
import { getSettings } from '../shared/config';
import type { SiteAdapter } from '../sites/types';
import type { MatchReply, MatchMessage } from '../background/index';
import type { AlgoliaResponse, MatchResult, RawBeer, EnrichCandidate, EnrichResult } from '../api/types';

const sendMatch: SendMatch = (cards: RawBeer[]) =>
  new Promise<MatchResult[]>((resolve, reject) => {
    const message: MatchMessage = { type: 'match', cards };
    chrome.runtime.sendMessage(message, (reply: MatchReply | undefined) => {
      if (chrome.runtime.lastError || !reply) {
        reject(new Error(chrome.runtime.lastError?.message ?? 'no reply'));
        return;
      }
      if (reply.type === 'match:ok') resolve(reply.results);
      else reject(new Error(reply.code));
    });
  });

function sendBg<T>(message: unknown): Promise<T | undefined> {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, (r: T) => resolve(r)));
}

// Bridges the page's orphan beers into the enrichment queue: gated on the opt-in setting,
// relays Untappd fetch + /enrich/* calls through the service worker, and drives badge states.
// Exported for tests only: the two mappings below are plain field copies, so a dropped
// optional field (a bid that never reaches the server) still compiles and still passes
// every other test — the "ships dead" failure mode #384 already paid for once.
export const enrichOrphans: EnrichOrphans = (orphans) => {
  void (async () => {
    // #648 (рев'ю PR #670): `runOverlay` намалював цим карткам «в черзі» саме тому, що
    // цей колбек існує. Якщо дошук вимкнено опцією, черги не буде — і мовчазний `return`
    // лишив би їх крутити кільце до кінця сторінки. Тож перед виходом віддаємо кожній той
    // стан, який уже довів `/match`.
    const { enrichEnabled } = await getSettings();
    if (!enrichEnabled) {
      for (const o of orphans) renderState(o.el, o.state);
      return;
    }
    // Ключ нормалізований, тож дві однакові картки на сторінці ділять його. Мапа на один
    // елемент оновлювала б лише останню, а решта лишалася б у «черзі» назавжди.
    //
    // Але ділити відповідь можна лише тим, хто справді питає одне й те саме (рев'ю PR
    // #670): дві картки з однаковим текстом можуть публікувати різні Untappd-id. Далі по
    // шляху дошуку ідентичність — це пара «броварня+назва» (`byPair` у `runEnrichment`),
    // тож обидві заявки він фізично тримати не може. Отже: однакові факти — одна заявка на
    // всіх; інші факти — окрема картка, яка лишається на тому, що вже довів `/match`, а не
    // позичає чужу відповідь.
    const factsOf = (o: { bid?: number; bidSlug?: string; brand?: string; abv?: number; style?: string }) =>
      JSON.stringify([o.bid ?? null, o.bidSlug ?? null, o.brand ?? null, o.abv ?? null, o.style ?? null]);
    const elsByKey = new Map<string, HTMLElement[]>();
    const representative = new Map<string, string>();
    const queued: typeof orphans = [];
    for (const o of orphans) {
      const facts = factsOf(o);
      const known = representative.get(o.key);
      if (known === undefined) {
        representative.set(o.key, facts);
        elsByKey.set(o.key, [o.el]);
        queued.push(o);
      } else if (known === facts) {
        elsByKey.get(o.key)!.push(o.el);
      } else {
        renderState(o.el, o.state);
      }
    }
    // #648: стан, яким картка стане, якщо дошук не знайде нічого кращого. Його порахував
    // `runOverlay` з відповіді `/match` — дошук цієї відповіді не бачить узагалі.
    const fallbackByKey = new Map<string, CardState>(queued.map((o) => [o.key, o.state]));
    const identityByKey = new Map(queued.map((o) => [o.key, { brewery: o.brewery, name: o.name }]));
    // Питаємо один раз на ключ: інакше кожен дублікат коштував би власного слота з
    // двадцяти, а другий пошук перемальовував би вже знайдену картку назад у «працюємо».
    const beers: OrphanBeer[] = queued.map((o) => ({
      key: o.key,
      brewery: o.brewery,
      name: o.name,
      ...(o.abv !== undefined ? { abv: o.abv } : {}),
      ...(o.style !== undefined ? { style: o.style } : {}),
      // #384/#307: normally brand equals the hydrated brewery; Flasker imports carry
      // the explicit placeholder separately from their title identity.
      ...(o.bid !== undefined ? { bid: o.bid } : {}),
      ...(o.bidSlug !== undefined ? { bidSlug: o.bidSlug } : {}),
      ...(o.brand !== undefined ? { brand: o.brand } : {}),
    }));
    await runEnrichment(beers, {
      getCandidates: async (bs) =>
        (await sendBg<{ candidates: EnrichCandidate[] }>({ type: 'enrich:candidates', beers: bs }))?.candidates ?? [],
      fetchSearch: async (algolia) =>
        (await sendBg<{ algolia: AlgoliaResponse | null }>({ type: 'enrich:fetch', algolia }))?.algolia ?? null,
      submitResult: async (brewery, name, algolia, facts, query) =>
        (await sendBg<{ result: EnrichResult | null }>({
          type: 'enrich:result', brewery, name, algolia, query,
          ...(facts?.abv !== undefined ? { abv: facts.abv } : {}),
          ...(facts?.style !== undefined ? { style: facts.style } : {}),
          ...(facts?.bid !== undefined ? { bid: facts.bid } : {}),
          ...(facts?.bidSlug !== undefined ? { bidSlug: facts.bidSlug } : {}),
          ...(facts?.brand !== undefined ? { brand: facts.brand } : {}),
          pageUrl: window.location.href,
        }))?.result ?? { status: 'transient' },
      // #648: дошук повідомляє події, а в бейдж їх перекладає одне це місце. Так уся мапа
      // «що сталося → що людина бачить» лишається там само, де стан із `/match`.
      //
      // Відома межа: `found` після дошуку не знає, чи людина це пиво пила — `/enrich/result`
      // статусу «пив» не несе, тож картка до й після перезавантаження може виглядати
      // по-різному. Це не регрес цього issue (так було завжди); фіксить #666, який навчить
      // дошук оновлювати кеш.
      onEvent: (key, ev) => {
        const els = elsByKey.get(key);
        if (!els) return;
        const id = identityByKey.get(key);
        const draw = (state: CardState) => {
          for (const el of els) renderState(el, state);
        };
        switch (ev.kind) {
          case 'searching':
            return draw({ kind: 'working' });
          case 'found':
            return draw({
              kind: 'found', drunk: false, mine: null, global: ev.ratingGlobal,
              unsure: false, untappdId: ev.untappdId,
              brewery: id?.brewery ?? '', name: id?.name ?? '',
            });
          case 'settled':
            return draw(
              fallbackByKey.get(key)
                ?? { kind: 'missing', brewery: id?.brewery ?? '', name: id?.name ?? '', orphan: false },
            );
          case 'deferred':
            return draw({ kind: 'deferred' });
          case 'failed':
            return draw({ kind: 'failed', reason: ev.reason });
        }
      },
    });
  })();
};

/**
 * Run the overlay once, then keep it in sync across in-shop navigation. Returns
 * a disposer that detaches the re-render observer.
 */
export function startOverlay(
  doc: Document,
  adapter: SiteAdapter,
  send: SendMatch,
  opts?: ReRenderOptions,
  enrich?: EnrichOrphans,
): () => void {
  const run = () => runOverlay(doc, adapter, send, enrich);

  const hasUnprocessed = () => {
    const scope = adapter.reRenderContainerSelector
      ? doc.querySelector(adapter.reRenderContainerSelector) ?? doc
      : doc;
    return adapter.parseCards(scope).some((card) => !isSeen(card.el));
  };

  let dispose: () => void = () => {};
  // First pass awaits waitForGrid, so the grid exists before we observe.
  void run().then(() => {
    dispose = observeReRender(doc, hasUnprocessed, run, opts);
  });

  return () => dispose();
}

const pageUrl = new URL(window.location.href);
const adapter = pickAdapter(pageUrl);
if (adapter && !adapter.isNonBeerPage?.(pageUrl)) {
  startOverlay(document, adapter, sendMatch, undefined, enrichOrphans);
  // Popup → "Refresh this page": drop the visible cards' cache entries and re-run
  // the overlay so badges reflect fresh server state without waiting out the TTL.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if ((message as { type?: unknown }).type !== 'refresh-page') return undefined;
    void (async () => {
      try {
        const keys = await refreshCards(document, adapter);
        await clearKeys(keys);
        await runOverlay(document, adapter, sendMatch, enrichOrphans);
        sendResponse({ ok: true, cleared: keys.length });
      } catch (err) {
        // Always answer so the popup never hangs on "Refreshing…".
        console.warn('[beer-overlay] refresh-page failed', err);
        sendResponse({ ok: false, cleared: 0 });
      }
    })();
    return true; // keep the message channel open for the async sendResponse
  });
}
