'use strict';
// Preloaded into the bot by start-check.cjs (--require). The check runs without network
// (spec 2026-10-11 §6.3), so Telegraf's bot.launch() rejects at getMe, and under Node's
// default that unhandled rejection kills the bot right after `api listening`. Only that
// rejection is tolerated: the FetchError node-fetch (Telegraf 4's client) raises for the
// getMe request — `request to https://api.telegram.org/bot<token>/getMe failed, reason: …`.
// Any other unhandled rejection, even one that merely mentions Telegram, ends the bot as
// Node's default would, after a marker line start-check.cjs looks for (#842 AI review).
const OFFLINE_GET_ME = /^request to https:\/\/api\.telegram\.org\/bot[^/\s]+\/getMe failed, reason: /;

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (reason instanceof Error && reason.name === 'FetchError' && OFFLINE_GET_ME.test(message)) {
    process.stderr.write('start-check: tolerated the offline Telegram launch rejection\n');
    return;
  }
  process.stderr.write(`start-check: unhandled rejection: ${message}\n`);
  process.exit(1);
});
