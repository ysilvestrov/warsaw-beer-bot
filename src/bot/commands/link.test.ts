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

// #609: the scheme was mandatory inside the optional URL group, so the schemeless form
// was rejected — the very form spec.md:629 promises, that `link.usage` tells the user to
// send, and that `link.success` echoes back at them.
test('accepts the schemeless URL that the usage text and spec promise', () => {
  expect(parseLinkArgs('untappd.com/user/yuriy')).toEqual({ username: 'yuriy' });
  expect(parseLinkArgs('www.untappd.com/user/yuriy')).toEqual({ username: 'yuriy' });
  expect(parseLinkArgs('untappd.com/user/yuriy/')).toEqual({ username: 'yuriy' });
});

test('accepts the exact string link.success echoes, so copying it back works', () => {
  // link.success renders "✅ Linked to untappd.com/user/{username}".
  expect(parseLinkArgs('untappd.com/user/AlexFavorov')).toEqual({ username: 'AlexFavorov' });
});

test('rejects empty or junk', () => {
  expect(parseLinkArgs('')).toBeNull();
  expect(parseLinkArgs('not a username!')).toBeNull();
  expect(parseLinkArgs('a')).toBeNull();
});

// Widening the scheme must not widen the host: a lookalike domain would silently link the
// user to a username parsed out of somebody else's URL.
test('rejects hosts that are not untappd.com', () => {
  expect(parseLinkArgs('evil.com/user/yuriy')).toBeNull();
  expect(parseLinkArgs('untappd.com.evil.com/user/yuriy')).toBeNull();
  expect(parseLinkArgs('notuntappd.com/user/yuriy')).toBeNull();
  expect(parseLinkArgs('https://evil.com/user/yuriy')).toBeNull();
  expect(parseLinkArgs('untappd.com/brewery/yuriy')).toBeNull();
});
