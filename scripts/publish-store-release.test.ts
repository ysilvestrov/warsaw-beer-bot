import {
  readStoreEnv,
  storeZipPath,
  runRelease,
  DEFAULT_ITEM_ID,
  type ReleaseDeps,
} from './publish-store-release';

const ENV = {
  CWS_CLIENT_ID: 'cid',
  CWS_CLIENT_SECRET: 'sec',
  CWS_REFRESH_TOKEN: 'rt',
};

function deps(overrides: Partial<ReleaseDeps> = {}) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      getAccessToken: async () => {
        calls.push('token');
        return 'tok';
      },
      getItem: async () => {
        calls.push('getItem');
        return { id: DEFAULT_ITEM_ID, crxVersion: '0.12.0', uploadState: 'SUCCESS' };
      },
      uploadPackage: async () => {
        calls.push('upload');
      },
      publishItem: async () => {
        calls.push('publish');
        return ['OK'];
      },
      readZip: () => {
        calls.push('readZip');
        return Buffer.from('zip');
      },
      ...overrides,
    },
  };
}

describe('readStoreEnv', () => {
  it('names the missing variable', () => {
    expect(() => readStoreEnv({ ...ENV, CWS_REFRESH_TOKEN: undefined })).toThrow(
      /CWS_REFRESH_TOKEN/,
    );
  });

  it('defaults the item id to the published extension', () => {
    expect(readStoreEnv(ENV).itemId).toBe(DEFAULT_ITEM_ID);
  });

  it('lets CWS_ITEM_ID override the default', () => {
    expect(readStoreEnv({ ...ENV, CWS_ITEM_ID: 'other' }).itemId).toBe('other');
  });
});

describe('storeZipPath', () => {
  it('points at the store-suffixed artefact, not the dev zip', () => {
    expect(storeZipPath('/repo/extension', '0.13.0')).toBe(
      '/repo/extension/warsaw-beer-overlay-0.13.0-store.zip',
    );
  });
});

describe('runRelease', () => {
  it('aborts before uploading when the draft already carries this version', async () => {
    const { calls, deps: d } = deps();
    await expect(
      runRelease({ version: '0.12.0', zipPath: '/z.zip', env: readStoreEnv(ENV), deps: d }),
    ).rejects.toThrow(/0\.12\.0 is already uploaded/);
    expect(calls).toEqual(['token', 'getItem']);
  });

  it('uploads then publishes for a new version', async () => {
    const { calls, deps: d } = deps();
    const out = await runRelease({
      version: '0.13.0',
      zipPath: '/z.zip',
      env: readStoreEnv(ENV),
      deps: d,
    });
    expect(out).toBe('published');
    expect(calls).toEqual(['token', 'getItem', 'readZip', 'upload', 'publish']);
  });

  it('never publishes when the upload fails', async () => {
    const { calls, deps: d } = deps({
      uploadPackage: async () => {
        throw new Error('CWS upload failed (uploadState=FAILURE)');
      },
    });
    await expect(
      runRelease({ version: '0.13.0', zipPath: '/z.zip', env: readStoreEnv(ENV), deps: d }),
    ).rejects.toThrow(/upload failed/);
    expect(calls).not.toContain('publish');
  });

  it('explains a missing store package instead of leaking ENOENT', async () => {
    const { deps: d } = deps({
      readZip: () => {
        throw new Error("ENOENT: no such file or directory, open '/z.zip'");
      },
    });
    await expect(
      runRelease({ version: '0.13.0', zipPath: '/z.zip', env: readStoreEnv(ENV), deps: d }),
    ).rejects.toThrow(/Store package not found at \/z\.zip/);
  });

  it('propagates a non-ENOENT read failure instead of the "not found" hint', async () => {
    const eacces = Object.assign(new Error("EACCES: permission denied, open '/z.zip'"), {
      code: 'EACCES',
    });
    const { deps: d } = deps({
      readZip: () => {
        throw eacces;
      },
    });
    await expect(
      runRelease({ version: '0.13.0', zipPath: '/z.zip', env: readStoreEnv(ENV), deps: d }),
    ).rejects.toThrow(/EACCES: permission denied/);
    await expect(
      runRelease({ version: '0.13.0', zipPath: '/z.zip', env: readStoreEnv(ENV), deps: d }),
    ).rejects.not.toThrow(/Store package not found/);
  });

  it('dry-run stops after the preflight', async () => {
    const { calls, deps: d } = deps();
    const out = await runRelease({
      version: '0.13.0',
      zipPath: '/z.zip',
      env: readStoreEnv(ENV),
      dryRun: true,
      deps: d,
    });
    expect(out).toBe('dry-run');
    expect(calls).toEqual(['token', 'getItem']);
  });
});
