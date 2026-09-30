// One-time login of the festival bot into the Untappd MCP (spec 2026-09-29-wfp-team-assistant-design.md
// §4.5). Run on a laptop with a browser, as the owner of the Untappd account the MCP is connected to:
//
//   npx tsx scripts/fest-mcp-login.ts --out ./tmp/fest-mcp-oauth.json [--url <mcp url>]
//
// It registers a client, opens the login page, catches the redirect on localhost:8765, stores the
// tokens and the owner's Untappd username in the file, and then checks the file works: one
// get_untappd_api_usage call and one friend-feed record read through the bot's own parser. It never
// prints a token. Copy the file to the server (owner warsaw-beer-bot, mode 600) at FEST_MCP_OAUTH_FILE.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { FileOAuthProvider } from '../src/sources/untappd/mcp-oauth-file';
import { parseMcpCheckins } from '../src/sources/untappd/mcp-checkins';
import type { ToolCallResult } from '../src/sources/untappd/mcp-client';

const DEFAULT_URL = 'https://untappd-mcp-ohilzxunwa-ew.a.run.app/mcp';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Waits for the OAuth redirect on localhost:8765 and returns the authorization code. */
function waitForCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost:8765');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end(code ? 'Готово — можна закрити вкладку.' : 'Немає коду в редиректі.');
      server.close();
      if (code) resolve(code);
      else reject(new Error(`no code in redirect: ${url.searchParams.get('error') ?? 'unknown'}`));
    });
    server.listen(8765, '127.0.0.1');
  });
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

async function connect(url: URL, provider: FileOAuthProvider): Promise<Client> {
  const client = new Client({ name: 'warsaw-beer-bot-fest-login', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url, { authProvider: provider }));
  return client;
}

const textOf = (r: { content?: unknown }): string => {
  const first = Array.isArray(r.content) ? (r.content[0] as { text?: unknown } | undefined) : undefined;
  return typeof first?.text === 'string' ? first.text : '';
};

async function main(): Promise<void> {
  const out = arg('--out');
  if (!out) throw new Error('usage: npx tsx scripts/fest-mcp-login.ts --out <file> [--url <mcp url>]');
  const url = new URL(arg('--url') ?? DEFAULT_URL);
  const provider = new FileOAuthProvider(out, (loginUrl) => {
    console.log(`\nВідкрий у браузері й увійди тим самим способом, що й у конекторі claude.ai:\n\n${loginUrl.href}\n`);
    openBrowser(loginUrl.href);
  });

  let client: Client;
  try {
    client = await connect(url, provider);
    console.log('Файл уже має робочі токени — вхід не знадобився.');
  } catch (e) {
    if (!(e instanceof UnauthorizedError)) throw e;
    const code = await waitForCode();
    // finishAuth lives on the transport that started the flow; a fresh one reads the same file.
    const transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
    await transport.finishAuth(code);
    client = await connect(url, provider);
    console.log('Вхід пройшов, токени збережено.');
  }

  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as ToolCallResult;
  const profile = JSON.parse(textOf(await call('get_my_profile', {}))) as {
    user?: { user_name?: string };
  };
  const owner = profile.user?.user_name;
  if (!owner) throw new Error('get_my_profile did not return a user_name — the MCP is not connected to Untappd for this login');
  provider.saveOwner(owner);
  console.log(`Власник токена в Untappd: ${owner}`);

  const usage = await call('get_untappd_api_usage', {});
  const feed = parseMcpCheckins(await call('get_my_friend_feed', { limit: 1 }));
  await client.close();
  console.log(`get_untappd_api_usage: ${usage.isError ? `помилка — ${textOf(usage)}` : 'ок'}`);
  console.log('error' in feed
    ? `get_my_friend_feed: не розібрано — ${feed.error}`
    : `get_my_friend_feed: розібрано записів ${feed.items.length} з ${feed.count}, поля на місці`);
  // A file that fails either check would not serve the festival job: do not tell anyone to deploy it.
  if (usage.isError || 'error' in feed) {
    throw new Error(`Перевірка не пройшла — файл ${out} на сервер НЕ переносити. Виправ причину й запусти скрипт ще раз.`);
  }
  console.log(`\nФайл: ${out}. Перенеси його на сервер (власник warsaw-beer-bot, права 600). Не архівуй і не пересилай.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
