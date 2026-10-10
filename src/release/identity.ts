import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The release identity the process started from (spec §7, §10a «/health.releaseSha»): read ONCE at
// startup from release.json at the application root and frozen for the life of the process. It says
// «this process read identity X at startup», not where X came from — provenance is the receipt's job.

export const RELEASE_JSON = 'release.json';
export const RELEASE_FORMAT_VERSION = 1;
const SHA = /^[0-9a-f]{40}$/;

export interface ReleaseHost {
  os: string;
  arch: string;
  libc: string;
  nodeVersion: string;
}

export interface ReleaseIdentityInput {
  // realpath of the application root (the directory that holds dist/ and release.json).
  root: string;
  required: boolean;
  readFile?: (path: string) => string;
  host?: ReleaseHost;
}

export interface ReleaseIdentity {
  releaseSha: string | null;
  // Why release.json was not accepted when it exists but is invalid (not required ⇒ the caller warns).
  problem: string | null;
}

export function currentHost(): ReleaseHost {
  const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
  const header = report.header ?? {};
  return {
    os: process.platform,
    arch: process.arch,
    libc: header.glibcVersionRuntime ? 'glibc' : 'other',
    nodeVersion: process.versions.node,
  };
}

function field(obj: unknown, key: string): unknown {
  return obj !== null && typeof obj === 'object' && !Array.isArray(obj)
    ? (obj as Record<string, unknown>)[key]
    : undefined;
}

// The reason release.json does not describe a release this process can be, or null when it does.
function invalidReason(info: unknown, host: ReleaseHost): string | null {
  const formatVersion = field(info, 'formatVersion');
  if (formatVersion !== RELEASE_FORMAT_VERSION) return `formatVersion ${JSON.stringify(formatVersion)} is not ${RELEASE_FORMAT_VERSION}`;
  const sha = field(info, 'sourceSha');
  if (typeof sha !== 'string' || !SHA.test(sha)) return `sourceSha ${JSON.stringify(sha)} is not 40 lowercase hex`;
  const platform = field(info, 'platform');
  for (const key of ['os', 'arch', 'libc'] as const) {
    const value = field(platform, key);
    if (value !== host[key]) return `platform.${key} ${JSON.stringify(value)} does not match this host (${host[key]})`;
  }
  const major = field(field(info, 'node'), 'major');
  const hostMajor = Number(host.nodeVersion.split('.')[0]);
  if (major !== hostMajor) return `node.major ${JSON.stringify(major)} does not match this Node (${host.nodeVersion})`;
  return null;
}

/**
 * Reads the identity once. Missing or invalid release.json: required ⇒ throws with the reason (startup
 * fails); not required ⇒ releaseSha null, with `problem` set only when the file exists but is invalid.
 */
export function readReleaseIdentity(input: ReleaseIdentityInput): ReleaseIdentity {
  const path = join(input.root, RELEASE_JSON);
  const read = input.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  let text: string;
  try {
    text = read(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      if (input.required) throw new Error(`release identity required: ${path} does not exist`);
      return { releaseSha: null, problem: null };
    }
    return reject(input.required, path, `unreadable (${code ?? String(err)})`);
  }
  let info: unknown;
  try {
    info = JSON.parse(text);
  } catch {
    return reject(input.required, path, 'not valid JSON');
  }
  const reason = invalidReason(info, input.host ?? currentHost());
  if (reason) return reject(input.required, path, reason);
  return { releaseSha: field(info, 'sourceSha') as string, problem: null };
}

function reject(required: boolean, path: string, reason: string): ReleaseIdentity {
  const problem = `${path}: ${reason}`;
  if (required) throw new Error(`release identity required: ${problem}`);
  return { releaseSha: null, problem };
}
