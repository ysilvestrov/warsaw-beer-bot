import { parseLinkArgs } from './link';

test('accepts a bare username', () => {
  expect(parseLinkArgs('yuriy')).toEqual({ username: 'yuriy' });
});

test('accepts a full URL', () => {
  expect(parseLinkArgs('https://untappd.com/user/yuriy')).toEqual({ username: 'yuriy' });
});

test('accepts a www URL', () => {
  expect(parseLinkArgs('https://www.untappd.com/user/yuriy')).toEqual({ username: 'yuriy' });
});

test('tolerates trailing slash', () => {
  expect(parseLinkArgs('yuriy/')).toEqual({ username: 'yuriy' });
});

test('rejects empty or junk', () => {
  expect(parseLinkArgs('')).toBeNull();
  expect(parseLinkArgs('not a username!')).toBeNull();
  expect(parseLinkArgs('a')).toBeNull();
});
