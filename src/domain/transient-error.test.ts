import { expect, test } from 'vitest';
import {
  APIConnectionError, APIConnectionTimeoutError, InternalServerError, RateLimitError, BadRequestError,
} from '@anthropic-ai/sdk';
import { HttpStatusError, isTransient } from './transient-error';

test('HttpStatusError carries the status; retriability comes from the status, not the class', () => {
  const e = new HttpStatusError('GitHub GET …: 502 bad gateway', 502);
  expect(e).toBeInstanceOf(Error);
  expect(e.status).toBe(502);
  expect(e.message).toContain('502');
  expect(isTransient(e)).toBe(true);
  expect(isTransient(new HttpStatusError('GitHub GET …: 403 forbidden', 403))).toBe(false);
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

test('real Anthropic SDK errors: 5xx/429/connection/timeout transient, 4xx not', () => {
  // The SDK leaves `name` as 'Error' on every error it throws (verified against
  // the installed @anthropic-ai/sdk) — only `constructor.name` identifies the
  // class. This is the real #316 bug: connection/timeout errors were previously
  // classified permanent.
  const headers = new Headers();
  expect(isTransient(new InternalServerError(500, { type: 'error' }, 'Internal server error', headers))).toBe(true);
  expect(isTransient(new RateLimitError(429, {}, 'slow down', headers))).toBe(true);
  expect(isTransient(new APIConnectionError({ message: 'Connection error.' }))).toBe(true);
  expect(isTransient(new APIConnectionTimeoutError({ message: 'Request timed out.' }))).toBe(true);
  expect(isTransient(new BadRequestError(400, {}, 'bad request', headers))).toBe(false);
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
