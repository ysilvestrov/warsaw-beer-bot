#!/usr/bin/env node
'use strict';
// The START step of the image's compat check (spec
// docs/superpowers/specs/2026-10/2026-10-11-wbb-image-deployment-design.md §6.3) and of
// the CI smoke (§3.1): the bot in THIS image starts on whatever DATABASE_PATH the
// (substitute) environment names, gets through its startup work to `api listening`,
// answers /health from inside the container, and is stopped.
//
// The bot runs as a child with this process's environment, from this process's
// working directory, with offline-telegram.cjs preloaded: the check runs without network
// (§6.3), so Telegraf's bot.launch() always rejects at getMe right after startup, and
// under Node's default (throw) that kills the bot within milliseconds of `api listening`
// (seen on the image 2026-10-11). The preload tolerates only that rejection; any other
// unhandled rejection still ends the bot and fails the check (#842 AI review). `api listening` is logged after the startup backfills and the
// bot launch (src/index.ts), so reaching it means the startup transformations ran.
//
// Usage: node start-check.cjs [--timeout <seconds>] [--entry <file>] [--leave-running]
//        --timeout        how long to wait for `api listening` (default 60)
//        --entry          the bot to start (default <app>/dist/index.js, <app> = two levels up)
//        --leave-running  exit right after the verdict without stopping the bot. Only for this
//                         script as PID 1 of a container (the host's compat check, the CI smoke):
//                         under the host's AppArmor no process in a container may signal another
//                         one of it (spec §2 V11: kill → EACCES), and the PID namespace teardown
//                         that follows PID 1's exit kills the bot instead (a kernel SIGKILL that
//                         AppArmor does not check). Outside a container the bot would be orphaned.
// Exit:  0 `START OK <releaseSha>`, 1 `START FAILED: <reason>` then the output tail,
//        75 `START TIMEOUT: …` then the tail — could not judge, not a verdict on the bot (§6.3),
//        64 usage. Everything goes to stdout; the verdict is the first line.
const { spawn } = require('node:child_process');
const path = require('node:path');

const APP = path.resolve(__dirname, '..', '..');
const READY = 'api listening';
const DEFAULT_TIMEOUT_S = 60;
const HEALTH_TIMEOUT_MS = 10_000;
// The unit's TimeoutStopSec (spec §3.2): a bot that outlives it is killed.
const STOP_GRACE_MS = 20_000;
const PRELOAD = path.join(__dirname, 'offline-telegram.cjs');
const UNHANDLED = 'start-check: unhandled rejection:';
// After a healthy /health, how long the bot must stay up: a rejection that lands right after
// `api listening` ends it within this time.
const SETTLE_MS = 1000;
const TAIL_CHARS = 4000;
const EX_TEMPFAIL = 75;

function parseArgs(argv) {
  const opts = { timeoutS: DEFAULT_TIMEOUT_S, entry: path.join(APP, 'dist', 'index.js'), leaveRunning: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--leave-running') {
      opts.leaveRunning = true;
      continue;
    }
    const value = argv[i + 1];
    i += 1;
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
  const child = spawn(process.execPath, ['--require', PRELOAD, entry], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
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
    console.error('usage: start-check.cjs [--timeout <seconds>] [--entry <file>] [--leave-running]  (API_PORT, if set, a positive integer)');
    return { code: 64, leave: false };
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
    if (h.ok) await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    if (bot.tail().includes(UNHANDLED)) {
      verdict = { ok: false, reason: 'an unhandled rejection other than the offline Telegram launch ended the bot' };
    } else if (!h.ok) verdict = { ok: false, reason: h.reason };
    else if (!running(bot.child)) verdict = { ok: false, reason: 'the bot exited after a healthy /health' };
    else verdict = { ok: true, releaseSha: h.releaseSha };
  } else if (outcome.kind === 'exit') {
    verdict = { ok: false, reason: `bot exited (${outcome.signal ?? `code ${outcome.code}`}) before "${READY}"` };
  } else if (outcome.kind === 'error') {
    verdict = { ok: false, reason: `bot did not start: ${outcome.message}` };
  } else {
    verdict = { ok: false, timeout: true, reason: `no "${READY}" within ${opts.timeoutS}s` };
  }
  if (!opts.leaveRunning) await stop(bot.child);
  if (verdict.ok) {
    console.log(`START OK ${verdict.releaseSha}`);
    return { code: 0, leave: opts.leaveRunning };
  }
  console.log(`${verdict.timeout ? 'START TIMEOUT' : 'START FAILED'}: ${verdict.reason}`);
  console.log(`output tail:\n${bot.tail()}`);
  return { code: verdict.timeout ? EX_TEMPFAIL : 1, leave: opts.leaveRunning };
}

main(process.argv.slice(2)).then(({ code, leave }) => {
  // The bot still holds the pipes and keeps the event loop alive: exit now, and the
  // container's end takes it down. stdout is a pipe or a file, written synchronously on Linux.
  if (leave) process.exit(code);
  process.exitCode = code;
});
