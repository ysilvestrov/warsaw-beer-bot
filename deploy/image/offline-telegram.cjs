'use strict';
// Preloaded into the bot by start-check.cjs (--require). The check runs without network
// (spec 2026-10-11 §6.3), so Telegraf's bot.launch() rejects at getMe, and under Node's
// default that unhandled rejection kills the bot right after `api listening`. Only that
// rejection — one whose message names api.telegram.org — is tolerated. Any other
// unhandled rejection ends the bot as Node's default would, after a marker line
// start-check.cjs looks for: a startup failure the check must not hide (#842 AI review).
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (/api\.telegram\.org/.test(message)) {
    process.stderr.write('start-check: tolerated the offline Telegram launch rejection\n');
    return;
  }
  process.stderr.write(`start-check: unhandled rejection: ${message}\n`);
  process.exit(1);
});
