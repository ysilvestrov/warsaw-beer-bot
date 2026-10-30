import { describe, it, expect, vi, afterEach } from 'vitest';
import { syncInstall, forgetInstallToken } from './install';
import { getSettings, setSettings } from '../shared/config';

afterEach(() => { vi.unstubAllGlobals(); });

type Call = { url: string; method: string; auth: string | undefined; body: unknown };

function server(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call = { url, method: init.method ?? 'GET', auth: headers.Authorization, body: init.body ? JSON.parse(init.body as string) : undefined };
    calls.push(call);
    return respond(call);
  }));
  return calls;
}

const issued = () => new Response(JSON.stringify({ install_id: 'i-1', token: 'wbi_new' }), { status: 201 });

describe('syncInstall — registration', () => {
  it('registers a fresh install with the manifest version and stores the token', async () => {
    const calls = server(issued);
    expect(await syncInstall()).toBe('registered');
    expect(calls).toEqual([{ url: 'https://beer-api.ysilvestrov-ai.uk/installs', method: 'POST', auth: undefined, body: { version: '9.9.9' } }]);
    expect((await getSettings()).installToken).toBe('wbi_new');
  });

  it('does not register when a Telegram token is set', async () => {
    await setSettings({ token: 'tg' });
    const calls = server(issued);
    expect(await syncInstall()).toBe('none');
    expect(calls).toEqual([]);
  });

  it('does not register again when an install token is already stored', async () => {
    await setSettings({ installToken: 'wbi_old' });
    const calls = server(issued);
    expect(await syncInstall()).toBe('registered');
    expect(calls).toEqual([]);
  });

  it('does not register when statistics are switched off', async () => {
    await setSettings({ installRegistration: false });
    const calls = server(issued);
    expect(await syncInstall()).toBe('none');
    expect(calls).toEqual([]);
  });

  it('a refused registration (daily cap) throws and stores nothing', async () => {
    server(() => new Response('{"error":"registrations_capped"}', { status: 429 }));
    await expect(syncInstall()).rejects.toMatchObject({ code: 'server' });
    expect((await getSettings()).installToken).toBe('');
  });

  it('switching statistics off while registering deletes the token just issued instead of keeping it', async () => {
    const calls = server(async (call) => {
      if (call.method === 'POST') { await setSettings({ installRegistration: false }); return issued(); }
      return new Response(null, { status: 204 });
    });
    expect(await syncInstall()).toBe('none');
    expect(calls.map((c) => [c.method, c.auth])).toEqual([['POST', undefined], ['DELETE', 'Bearer wbi_new']]);
    expect((await getSettings()).installToken).toBe('');
  });
});

describe('syncInstall — pending deletion', () => {
  it('a confirmed deletion clears the token and the pending flag', async () => {
    await setSettings({ installToken: 'wbi_old', installRegistration: false, installDeletionPending: true });
    const calls = server(() => new Response(null, { status: 204 }));
    expect(await syncInstall()).toBe('none');
    expect(calls).toEqual([{ url: 'https://beer-api.ysilvestrov-ai.uk/installs/me', method: 'DELETE', auth: 'Bearer wbi_old', body: undefined }]);
    expect(await getSettings()).toMatchObject({ installToken: '', installDeletionPending: false });
  });

  it('a 401 on deletion counts as deleted — the server has forgotten the install already', async () => {
    await setSettings({ installToken: 'wbi_old', installRegistration: false, installDeletionPending: true });
    server(() => new Response('{}', { status: 401 }));
    expect(await syncInstall()).toBe('none');
    expect(await getSettings()).toMatchObject({ installToken: '', installDeletionPending: false });
  });

  it('an unreachable server keeps the token and the flag for the next start', async () => {
    await setSettings({ installToken: 'wbi_old', installRegistration: false, installDeletionPending: true });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    expect(await syncInstall()).toBe('deletion_pending');
    expect(await getSettings()).toMatchObject({ installToken: 'wbi_old', installDeletionPending: true });
  });

  it('switching back on while a deletion is pending deletes first, then registers a new install', async () => {
    await setSettings({ installToken: 'wbi_old', installRegistration: true, installDeletionPending: true });
    const calls = server((call) => (call.method === 'DELETE' ? new Response(null, { status: 204 }) : issued()));
    expect(await syncInstall()).toBe('registered');
    expect(calls.map((c) => [c.method, c.auth])).toEqual([['DELETE', 'Bearer wbi_old'], ['POST', undefined]]);
    expect(await getSettings()).toMatchObject({ installToken: 'wbi_new', installDeletionPending: false });
  });
});

describe('forgetInstallToken', () => {
  it('forgets the rejected token', async () => {
    await setSettings({ installToken: 'wbi_old' });
    await forgetInstallToken('wbi_old');
    expect((await getSettings()).installToken).toBe('');
  });

  it('keeps a token that already replaced the rejected one', async () => {
    await setSettings({ installToken: 'wbi_new' });
    await forgetInstallToken('wbi_old');
    expect((await getSettings()).installToken).toBe('wbi_new');
  });
});
