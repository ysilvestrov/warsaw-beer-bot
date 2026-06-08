import { describe, it, expect, vi, afterEach } from 'vitest';
import { testConnection } from './options';
import * as client from '../api/client';
import { ApiError } from '../api/client';

afterEach(() => vi.restoreAllMocks());

describe('testConnection', () => {
  it('ok when health passes and a probe match succeeds', async () => {
    vi.spyOn(client, 'getHealth').mockResolvedValue(true);
    vi.spyOn(client, 'postMatch').mockResolvedValue([]);
    expect(await testConnection('https://api.test', 'tok')).toEqual({ ok: true });
  });

  it('fails with reason "health" when health is down', async () => {
    vi.spyOn(client, 'getHealth').mockResolvedValue(false);
    expect(await testConnection('https://api.test', 'tok')).toEqual({ ok: false, reason: 'health' });
  });

  it('fails with reason "unauthorized" when the probe match is 401', async () => {
    vi.spyOn(client, 'getHealth').mockResolvedValue(true);
    vi.spyOn(client, 'postMatch').mockRejectedValue(new ApiError('unauthorized'));
    expect(await testConnection('https://api.test', 'bad')).toEqual({ ok: false, reason: 'unauthorized' });
  });
});
