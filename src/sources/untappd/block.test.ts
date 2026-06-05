import { isBlockStatus, isBlockPage } from './block';

test('isBlockStatus: 403/429 true, others false', () => {
  expect(isBlockStatus(403)).toBe(true);
  expect(isBlockStatus(429)).toBe(true);
  expect(isBlockStatus(404)).toBe(false);
  expect(isBlockStatus(500)).toBe(false);
  expect(isBlockStatus(200)).toBe(false);
});

test('isBlockPage: cloudflare challenge markers → true', () => {
  expect(isBlockPage('<title>Just a moment...</title>')).toBe(true);
  expect(isBlockPage('<div class="cf-browser-verification">x</div>')).toBe(true);
  expect(isBlockPage('<h1>Attention Required! | Cloudflare</h1>')).toBe(true);
  expect(isBlockPage('<p>Please enable JavaScript and cookies to continue</p>')).toBe(true);
});

test('isBlockPage: normal & zero-result search pages → false', () => {
  expect(isBlockPage('<html><body><div class="beer-item" data-bid="1"></div></body></html>')).toBe(false);
  expect(isBlockPage('<html><body><p>No beers found</p></body></html>')).toBe(false);
  expect(isBlockPage('')).toBe(false);
});
