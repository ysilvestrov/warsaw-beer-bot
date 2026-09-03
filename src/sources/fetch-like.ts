import type { Dispatcher } from 'undici';

// #581: глобальний `fetch` у Node 24 — це ВБУДОВАНА копія undici, а `dispatcher`, який ми йому
// даємо, — з npm-пакета undici v8. Контракти хендлера в двох копіях різні, тож npm-івський
// `assertRequestHandler` відкидає хендлер, побудований внутрішньою:
// `InvalidArgumentError: invalid onRequestStart method`. Лікується тим, що модуль, який віддає
// `dispatcher`, бере `fetch` з ТОГО САМОГО пакета.
//
// Шов звужено до того, що `http.ts` і `algolia.ts` справді вживають (`ok`, `status`, `text`,
// `json`), бо `undici.fetch` НЕ присвоюється до `typeof fetch` — типи розходяться на
// `Request.duplex`/`textStream`. Каст був би одним рядком, але сховав би саме те неспівпадіння,
// яке ця робота й лагодить, і наступний такий баг знову став би невидимим для компілятора.

export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface FetchInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  redirect?: RequestRedirect;
  dispatcher?: Dispatcher;
}

export type FetchLike = (url: string, init?: FetchInitLike) => Promise<FetchResponseLike>;
