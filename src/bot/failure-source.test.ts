import type { Update } from '@telegraf/types';
import { failureSource } from './failure-source';

const text = (t: string) => ({ update_id: 1, message: { message_id: 1, date: 0, chat: { id: 5, type: 'private' }, text: t } }) as unknown as Update;

test('a command gives its name without arguments', () => {
  expect(failureSource(text('/beers piw paw'))).toBe('/beers');
});
test('a command addressed to the bot loses the @botname', () => {
  expect(failureSource(text('/route@WarsawBeerBot 12'))).toBe('/route');
});
test('a command is lower-cased', () => {
  expect(failureSource(text('/Beers'))).toBe('/beers');
});
test('plain text is "text" — what the person typed is not kept', () => {
  expect(failureSource(text('piw paw'))).toBe('text');
});
test('a slash in the middle of a text is not a command', () => {
  expect(failureSource(text('see /beers'))).toBe('text');
});
test('a button press is "callback"', () => {
  expect(failureSource({ update_id: 1, callback_query: { id: 'q', data: 'rb:now:1' } } as unknown as Update)).toBe('callback');
});
test('a message without text (a document) is named by its update type', () => {
  const update = { update_id: 1, message: { message_id: 1, date: 0, chat: { id: 5, type: 'private' }, document: { file_id: 'f' } } };
  expect(failureSource(update as unknown as Update)).toBe('message');
});
test('any other update is named by its update type', () => {
  expect(failureSource({ update_id: 1, my_chat_member: {} } as unknown as Update)).toBe('my_chat_member');
});
test('an update with nothing but its id is "unknown"', () => {
  expect(failureSource({ update_id: 1 } as unknown as Update)).toBe('unknown');
});
test('a command name of 32 characters is kept, 33 is text the person typed', () => {
  expect([failureSource(text(`/${'a'.repeat(32)} x`)), failureSource(text(`/${'a'.repeat(33)}`))]).toEqual([
    '/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'text',
  ]);
});
test('a lone slash is text', () => {
  expect(failureSource(text('/'))).toBe('text');
});
test('an edited message with a command is named by its update type, never by its text', () => {
  const update = { update_id: 1, edited_message: { message_id: 1, date: 0, chat: { id: 5, type: 'private' }, text: '/beers secret' } };
  expect(failureSource(update as unknown as Update)).toBe('edited_message');
});
