import { afterEach, describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * deploy/image/start-check.cjs — the START step of the image compat check (spec
 * docs/superpowers/specs/2026-10/2026-10-11-wbb-image-deployment-design.md §6.3),
 * driven against fake bots: small CommonJS files standing in for dist/index.js.
 */
const START_CHECK = resolve(__dirname, '..', 'deploy/image/start-check.cjs');
const SHA = '0123456789abcdef0123456789abcdef01234567';
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'wbb-start-check-'));
  dirs.push(d);
  return d;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  await new Promise<void>((done) => server.close(() => done()));
  return (address as { port: number }).port;
}

const LOG_READY = "process.stdout.write('{\"level\":30,\"port\":' + port + ',\"msg\":\"api listening\"}\\n');";
const LOG_READY_SPLIT = "process.stdout.write('{\"msg\":\"api lis'); setTimeout(() => process.stdout.write('tening\"}\\n'), 200);";
// Like bot.launch() without network: a promise nobody awaits rejects right after startup.
// The shape node-fetch gives Telegraf 4's getMe without network (node_modules/node-fetch FetchError).
const REJECT_UNAWAITED = "Promise.reject(Object.assign(new Error('request to https://api.telegram.org/bot123456:abcdefghij/getMe failed, reason: getaddrinfo EAI_AGAIN api.telegram.org'), { name: 'FetchError' }));";

/**
 * A fake bot that serves `health` (status + JSON), then runs `onListening` (by default the
 * `api listening` line the way pino logs it) and records a SIGTERM in $STOP_MARKER.
 */
function servingBot(dir: string, health: { status: number; body: unknown }, onListening = LOG_READY): string {
  const file = join(dir, 'bot.cjs');
  writeFileSync(file, [
    "const http = require('node:http');",
    "const fs = require('node:fs');",
    'const port = Number(process.env.API_PORT);',
    `const server = http.createServer((req, res) => {`,
    `  res.writeHead(req.url === '/health' ? ${health.status} : 404, { 'content-type': 'application/json' });`,
    `  res.end(${JSON.stringify(JSON.stringify(health.body))});`,
    '});',
    `server.listen(port, '127.0.0.1', () => { ${onListening} });`,
    "process.once('SIGTERM', () => { fs.writeFileSync(process.env.STOP_MARKER, 'stopped by SIGTERM'); process.exit(0); });",
  ].join('\n'));
  return file;
}

function run(args: string[], env: Record<string, string>) {
  const result = spawnSync(process.execPath, [START_CHECK, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...env },
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('start-check', () => {
  test('a bot that reaches api listening and answers /health is START OK with its releaseSha, then stopped', async () => {
    const dir = scratch();
    const bot = servingBot(dir, { status: 200, body: { ok: true, releaseSha: SHA } });
    const marker = join(dir, 'stopped');
    const r = run(['--entry', bot, '--timeout', '10'], { API_PORT: String(await freePort()), STOP_MARKER: marker });
    expect(r).toEqual({ status: 0, stdout: `START OK ${SHA}\n`, stderr: '' });
    expect(readFileSync(marker, 'utf8')).toBe('stopped by SIGTERM');
  });

  test('api listening split across two writes is still seen', async () => {
    const dir = scratch();
    const bot = servingBot(dir, { status: 200, body: { ok: true, releaseSha: SHA } }, LOG_READY_SPLIT);
    const r = run(['--entry', bot, '--timeout', '10'], { API_PORT: String(await freePort()), STOP_MARKER: join(dir, 'm') });
    expect(r).toEqual({ status: 0, stdout: `START OK ${SHA}\n`, stderr: '' });
  });

  test('an unhandled rejection after api listening (bot.launch without network) does not fail the check', async () => {
    const dir = scratch();
    const bot = servingBot(dir, { status: 200, body: { ok: true, releaseSha: SHA } }, LOG_READY + REJECT_UNAWAITED);
    const r = run(['--entry', bot, '--timeout', '10'], { API_PORT: String(await freePort()), STOP_MARKER: join(dir, 'm') });
    expect(r).toEqual({ status: 0, stdout: `START OK ${SHA}\n`, stderr: '' });
  });

  // #842 AI review: only the offline Telegram launch is tolerated; any other startup rejection fails.
  test('an unhandled rejection that is not the Telegram launch is START FAILED, whatever /health managed', async () => {
    const dir = scratch();
    const other = "Promise.reject(new Error('SqliteError: no such column: x'));";
    const bot = servingBot(dir, { status: 200, body: { ok: true, releaseSha: SHA } }, LOG_READY + other);
    const r = run(['--entry', bot, '--timeout', '10'], { API_PORT: String(await freePort()), STOP_MARKER: join(dir, 'm') });
    expect([r.status, r.stdout.split('\n')[0], r.stdout.includes('start-check: unhandled rejection: SqliteError: no such column: x')]).toEqual([
      1, 'START FAILED: an unhandled rejection other than the offline Telegram launch ended the bot', true]);
  });

  // #842 AI review: mentioning Telegram is not enough; only the offline getMe FetchError is tolerated.
  test.each([
    ['a plain Error naming api.telegram.org', "Promise.reject(new Error('database init failed while handling api.telegram.org'));"],
    ['a FetchError for another Telegram method', "Promise.reject(Object.assign(new Error('request to https://api.telegram.org/botX/sendMessage failed, reason: x'), { name: 'FetchError' }));"],
  ])('%s is not the tolerated rejection', async (_name, reject) => {
    const dir = scratch();
    const bot = servingBot(dir, { status: 200, body: { ok: true, releaseSha: SHA } }, LOG_READY + reject);
    const r = run(['--entry', bot, '--timeout', '10'], { API_PORT: String(await freePort()), STOP_MARKER: join(dir, 'm') });
    expect([r.status, r.stdout.split('\n')[0]]).toEqual([1, 'START FAILED: an unhandled rejection other than the offline Telegram launch ended the bot']);
  });

  test('a bot that dies before api listening is START FAILED with its output tail', async () => {
    const dir = scratch();
    const bot = join(dir, 'crash.cjs');
    writeFileSync(bot, "process.stdout.write('starting\\n'); process.stderr.write('SqliteError: no such table: beers\\n'); process.exit(3);");
    const r = run(['--entry', bot, '--timeout', '10'], { API_PORT: String(await freePort()) });
    expect(r).toEqual({
      status: 1,
      stdout: 'START FAILED: bot exited (code 3) before "api listening"\n'
        + 'output tail:\nstarting\nSqliteError: no such table: beers\n\n',
      stderr: '',
    });
  });

  test('a bot that never logs api listening is START FAILED at the timeout', async () => {
    const dir = scratch();
    const bot = join(dir, 'silent.cjs');
    writeFileSync(bot, "process.stdout.write('waiting for telegram\\n'); setInterval(() => {}, 1000);");
    const r = run(['--entry', bot, '--timeout', '1'], { API_PORT: String(await freePort()) });
    expect(r).toEqual({
      status: 1,
      stdout: 'START FAILED: no "api listening" within 1s\noutput tail:\nwaiting for telegram\n\n',
      stderr: '',
    });
  });

  test('a /health that answers ok:false is START FAILED with what it answered', async () => {
    const dir = scratch();
    const bot = servingBot(dir, { status: 200, body: { ok: false, releaseSha: SHA } });
    const r = run(['--entry', bot, '--timeout', '10'], { API_PORT: String(await freePort()), STOP_MARKER: join(dir, 'm') });
    expect(r.status).toBe(1);
    expect(r.stdout.split('\n')[0]).toBe(`START FAILED: /health answered 200 {"ok":false,"releaseSha":"${SHA}"}`);
  });

  test('a /health with a non-200 status is START FAILED even with an ok body', async () => {
    const dir = scratch();
    const bot = servingBot(dir, { status: 503, body: { ok: true, releaseSha: SHA } });
    const r = run(['--entry', bot, '--timeout', '10'], { API_PORT: String(await freePort()), STOP_MARKER: join(dir, 'm') });
    expect(r.status).toBe(1);
    expect(r.stdout.split('\n')[0]).toBe(`START FAILED: /health answered 503 {"ok":true,"releaseSha":"${SHA}"}`);
  });

  test('a /health without a releaseSha is START FAILED', async () => {
    const dir = scratch();
    const bot = servingBot(dir, { status: 200, body: { ok: true, releaseSha: null } });
    const r = run(['--entry', bot, '--timeout', '10'], { API_PORT: String(await freePort()), STOP_MARKER: join(dir, 'm') });
    expect(r.status).toBe(1);
    expect(r.stdout.split('\n')[0]).toBe('START FAILED: /health answered 200 {"ok":true,"releaseSha":null}');
  });

  test.each([
    [['--timeout', '0']],
    [['--timeout', 'soon']],
    [['--timeout']],
    [['--entry']],
    [['--other', 'x']],
  ])('usage error %j exits 64 without starting anything', (args) => {
    const r = run(args, {});
    expect(r.status).toBe(64);
    expect(r.stdout).toBe('');
  });

  test('a non-numeric API_PORT is a usage error', () => {
    const r = run(['--timeout', '1'], { API_PORT: 'http' });
    expect(r.status).toBe(64);
    expect(r.stdout).toBe('');
  });
});
