#!/usr/bin/env node
'use strict';
// The START step of the image's compat check (spec
// docs/superpowers/specs/2026-10/2026-10-11-wbb-image-deployment-design.md §6.3) and of
// the CI smoke (§3.1): the bot in THIS image starts on whatever DATABASE_PATH the
// (substitute) environment names, gets through its startup work to `api listening`,
// answers /health from inside the container, and is stopped.
//
// The bot runs as a child with this process's environment, from this process's
// working directory, under --unhandled-rejections=warn: the check runs without network
// (§6.3), so Telegraf's bot.launch() always rejects at getMe right after startup, and
// under Node's default (throw) that kills the bot within milliseconds of `api listening`
// (seen on the image 2026-10-11). The rejection still shows in the output; the bot stays
// up to answer /health. `api listening` is logged after the startup backfills and the
// bot launch (src/index.ts), so reaching it means the startup transformations ran.
//
// Usage: node start-check.cjs [--timeout <seconds>] [--entry <file>]
//        --timeout  how long to wait for `api listening` (default 60)
//        --entry    the bot to start (default <app>/dist/index.js, <app> = two levels up)
// Exit:  0 `START OK <releaseSha>`, 1 `START FAILED: <reason>` then the output tail,
//        64 usage. Everything goes to stdout; the verdict is the first line.
const { spawn } = require('node:child_process');
const path = require('node:path');

const APP = path.resolve(__dirname, '..', '..');
const READY = 'api listening';
const DEFAULT_TIMEOUT_S = 60;
const HEALTH_TIMEOUT_MS = 10_000;
// The unit's TimeoutStopSec (spec §3.2): a bot that outlives it is killed.
const STOP_GRACE_MS = 20_000;
const TAIL_CHARS = 4000;

function parseArgs(argv) {
  const opts = { timeoutS: DEFAULT_TIMEOUT_S, entry: path.join(APP, 'dist', 'index.js') };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--timeout' && /^[1-9][0-9]{0,4}$/.test(value ?? '')) opts.timeoutS = Number(value);
    else if (flag === '--entry' && value) opts.entry = path.resolve(value);
    else return null;
  }
  return opts;
}

// API_PORT as src/config/env.ts reads it: a positive integer, 3000 when absent.
function apiPort(env) {
  if (env.API_PORT === undefined || env.API_PORT === '') return 3000;
  return /^[1-9][0-9]*$/.test(env.API_PORT) ? Number(env.API_PORT) : null;
}

function startBot(entry) {
  const child = spawn(process.execPath, ['--unhandled-rejections=warn', entry], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let tail = '';
  let carry = '';
  let onReady = () => {};
  const keep = (text) => {
    tail = (tail + text).slice(-TAIL_CHARS);
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (text) => {
    keep(text);
    // READY may straddle two chunks; carry just enough of the previous one.
    if ((carry + text).includes(READY)) onReady();
    carry = text.slice(-(READY.length - 1));
  });
  child.stderr.on('data', keep);
  const ready = new Promise((resolve) => {
    onReady = () => resolve({ kind: 'ready' });
    child.once('exit', (code, signal) => resolve({ kind: 'exit', code, signal }));
    child.once('error', (e) => resolve({ kind: 'error', message: e.message }));
  });
  return { child, ready, tail: () => tail };
}

async function health(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    const body = await res.text();
    let json = null;
    try {
      json = JSON.parse(body);
    } catch {
      json = null;
    }
    if (res.status === 200 && json && json.ok === true && typeof json.releaseSha === 'string') {
      return { ok: true, releaseSha: json.releaseSha };
    }
    return { ok: false, reason: `/health answered ${res.status} ${body.slice(0, 200)}` };
  } catch (e) {
    return { ok: false, reason: `/health: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function running(child) {
  return child.exitCode === null && child.signalCode === null;
}

async function stop(child) {
  if (!running(child)) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
  await exited;
  clearTimeout(timer);
}

async function main(argv) {
  const opts = parseArgs(argv);
  const port = apiPort(process.env);
  if (!opts || port === null) {
    console.error('usage: start-check.cjs [--timeout <seconds>] [--entry <file>]  (API_PORT, if set, a positive integer)');
    return 64;
  }
  const bot = startBot(opts.entry);
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), opts.timeoutS * 1000);
  });
  const outcome = await Promise.race([bot.ready, timeout]);
  clearTimeout(timer);
  let verdict;
  if (outcome.kind === 'ready') {
    const h = await health(port);
    verdict = h.ok ? { ok: true, releaseSha: h.releaseSha } : { ok: false, reason: h.reason };
  } else if (outcome.kind === 'exit') {
    verdict = { ok: false, reason: `bot exited (${outcome.signal ?? `code ${outcome.code}`}) before "${READY}"` };
  } else if (outcome.kind === 'error') {
    verdict = { ok: false, reason: `bot did not start: ${outcome.message}` };
  } else {
    verdict = { ok: false, reason: `no "${READY}" within ${opts.timeoutS}s` };
  }
  await stop(bot.child);
  if (verdict.ok) {
    console.log(`START OK ${verdict.releaseSha}`);
    return 0;
  }
  console.log(`START FAILED: ${verdict.reason}`);
  console.log(`output tail:\n${bot.tail()}`);
  return 1;
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
