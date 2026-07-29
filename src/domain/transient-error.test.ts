import { expect, test } from 'vitest';
import { HttpError, isTransient } from './transient-error';

test('HttpError carries the status; retriability comes from the status, not the class', () => {
  const e = new HttpError('GitHub GET …: 502 bad gateway', 502);
  expect(e).toBeInstanceOf(Error);
  expect(e.status).toBe(502);
  expect(e.message).toContain('502');
  expect(isTransient(e)).toBe(true);
  expect(isTransient(new HttpError('GitHub GET …: 403 forbidden', 403))).toBe(false);
});

test('duck-typed status: 5xx / 429 / 408 are transient, other 4xx are not', () => {
  // Shape of the Anthropic SDK's APIError — recognised without importing the SDK.
  expect(isTransient({ status: 500, name: 'InternalServerError' })).toBe(true);
  expect(isTransient({ status: 503 })).toBe(true);
  expect(isTransient({ status: 429 })).toBe(true);
  expect(isTransient({ status: 408 })).toBe(true);
  expect(isTransient({ status: 400 })).toBe(false);
  expect(isTransient({ status: 401 })).toBe(false);
  expect(isTransient({ status: 404 })).toBe(false);
  expect(isTransient({ status: '500' })).toBe(false);
});

test('network-level failures are transient', () => {
  const conn = new Error('Connection error.');
  conn.name = 'APIConnectionError';
  expect(isTransient(conn)).toBe(true);

  const timeout = new Error('Request timed out.');
  timeout.name = 'APIConnectionTimeoutError';
  expect(isTransient(timeout)).toBe(true);

  const abort = new Error('aborted');
  abort.name = 'AbortError';
  expect(isTransient(abort)).toBe(true);

  // Node's undici surfaces a network failure as TypeError('fetch failed') + cause.
  expect(isTransient(new TypeError('fetch failed', { cause: new Error('ECONNRESET') }))).toBe(true);
});

test('our own validation errors and non-Error throws are permanent', () => {
  expect(isTransient(new Error('triage LLM: invalid response shape: verdicts: required'))).toBe(false);
  expect(isTransient(new Error('triage LLM: response truncated (max_tokens)'))).toBe(false);
  expect(isTransient(new TypeError('x is not a function'))).toBe(false);  // no cause
  expect(isTransient('raw string failure')).toBe(false);
  expect(isTransient(null)).toBe(false);
  expect(isTransient(undefined)).toBe(false);
});
