import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  getAccessToken,
  getItem,
  publishItem,
  uploadPackage,
  type CwsCreds,
  type CwsItem,
} from './cws-client';

// Uploads the store build to the Chrome Web Store and submits it for review (#266).
// Run via `npm run release:store` from the repo root, which builds the store package
// first. Modelled on publish-extension-release.ts (the off-store bot channel), which
// stays a separate command.

export const DEFAULT_ITEM_ID = 'fdelmnhijeiojadcaihfdpecfcldbndg';

export interface StoreEnv extends CwsCreds {
  itemId: string;
}

export function readStoreEnv(env: Record<string, string | undefined>): StoreEnv {
  const need = (name: string): string => {
    const v = env[name];
    if (!v) throw new Error(`${name} is not set — see docs/extension-release.md (#266 setup)`);
    return v;
  };
  return {
    clientId: need('CWS_CLIENT_ID'),
    clientSecret: need('CWS_CLIENT_SECRET'),
    refreshToken: need('CWS_REFRESH_TOKEN'),
    itemId: env.CWS_ITEM_ID || DEFAULT_ITEM_ID,
  };
}

export function storeZipPath(extDir: string, version: string): string {
  return join(extDir, `warsaw-beer-overlay-${version}-store.zip`);
}

export interface ReleaseDeps {
  getAccessToken: (creds: CwsCreds) => Promise<string>;
  getItem: (itemId: string, token: string) => Promise<CwsItem>;
  uploadPackage: (itemId: string, zip: Uint8Array<ArrayBuffer>, token: string) => Promise<void>;
  publishItem: (itemId: string, token: string) => Promise<string[]>;
  readZip: (path: string) => Uint8Array<ArrayBuffer>;
}

export const defaultDeps: ReleaseDeps = {
  getAccessToken: (creds) => getAccessToken(creds),
  getItem: (itemId, token) => getItem(itemId, token),
  uploadPackage: (itemId, zip, token) => uploadPackage(itemId, zip, token),
  publishItem: (itemId, token) => publishItem(itemId, token),
  readZip: (path) => readFileSync(path),
};

export async function runRelease(opts: {
  version: string;
  zipPath: string;
  env: StoreEnv;
  dryRun?: boolean;
  deps?: ReleaseDeps;
}): Promise<'published' | 'dry-run'> {
  const deps = opts.deps ?? defaultDeps;
  const token = await deps.getAccessToken(opts.env);

  // Preflight: read the draft first. It turns the most common mistake (forgetting the
  // version bump) into a clear message BEFORE a minute-long upload, and it fails fast on
  // credential/access problems.
  const item = await deps.getItem(opts.env.itemId, token);
  if (item.crxVersion === opts.version) {
    throw new Error(
      `Version ${opts.version} is already uploaded to item ${item.id} — bump ` +
        '`extension/package.json` (and add a matching CHANGELOG section) first.',
    );
  }
  console.log(
    `item ${item.id}: draft ${item.crxVersion ?? '(none)'} → uploading ${opts.version}`,
  );
  if (opts.dryRun) return 'dry-run';

  let zip: Uint8Array<ArrayBuffer>;
  try {
    zip = deps.readZip(opts.zipPath);
  } catch (err) {
    // Only a genuinely missing file gets the friendly "go build it" hint. EACCES,
    // EISDIR and anything else are real problems the hint would send down the wrong
    // path, so they surface as-is (with context that it happened reading the store
    // package). Real `fs` failures are `NodeJS.ErrnoException`s with `.code ===
    // 'ENOENT'`; we also check the message prefix because the message text itself
    // ("ENOENT: no such file or directory, ...") is what real Node fs errors carry,
    // covering callers (incl. tests) that construct a plain Error with that text but no
    // `.code`.
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    const message = err instanceof Error ? err.message : String(err);
    if (code === 'ENOENT' || message.startsWith('ENOENT')) {
      throw new Error(
        `Store package not found at ${opts.zipPath} — build it with ` +
          '`npm --prefix extension run package:store` (or just use `npm run release:store`).',
      );
    }
    throw new Error(`Failed to read store package at ${opts.zipPath}: ${message}`, {
      cause: err,
    });
  }
  await deps.uploadPackage(opts.env.itemId, zip, token);
  console.log(`uploaded ${opts.zipPath} (${zip.length} bytes)`);

  const status = await deps.publishItem(opts.env.itemId, token);
  console.log(`submitted for review: ${status.join(', ')}`);
  return 'published';
}

async function main(): Promise<void> {
  const root = resolve(__dirname, '..');
  const extDir = resolve(root, 'extension');
  const version = (
    JSON.parse(readFileSync(resolve(extDir, 'package.json'), 'utf8')) as { version: string }
  ).version;

  await runRelease({
    version,
    zipPath: storeZipPath(extDir, version),
    env: readStoreEnv(process.env),
    dryRun: process.argv.includes('--dry-run'),
  });
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
