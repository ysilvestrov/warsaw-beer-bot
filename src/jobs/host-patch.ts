import { z } from 'zod';
import type { HostPatchFacts, HostPatchRead, ImageFacts } from '../domain/status/types';
import { readHardenedJson } from './hardened-json';

// The root collector's summary (#469 stage 2, scripts/ops/host_patch_collect.py).
const HOST_PATCH_PATH = '/var/tmp/wbb-host-patch/summary.json';
const MAX_BYTES = 16_384;
// The collector runs hourly: three missed runs mean it has stopped.
const STALE_SECONDS = 3 * 3600;
const ROOT_UID = 0;

const seconds = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const text = z.string().min(1).max(200);
const summarySchema = z.object({
  version: z.literal(1),
  timestamp: seconds,
  kernel: z.object({ running: text, newest_installed: text }).strict().nullable(),
  reboot_required: z.object({ since: seconds, packages: z.array(text).max(100) }).strict().nullable(),
  livepatch: z.object({
    state: z.enum(['applied', 'nothing-to-apply', 'unsupported-kernel', 'unknown']),
    upgrade_required_date: text.nullable(),
  }).strict().nullable(),
  stale_services: z.array(z.object({ unit: text, since: seconds }).strict()).max(200).nullable(),
  unattended: z.object({
    last_run: seconds.nullable(),
    security_pending: z.number().int().min(0).max(100_000).nullable(),
  }).strict(),
  packages: z.object({ nodejs: text.nullable(), cloudflared: text.nullable(), litestream: text.nullable() }).strict(),
}).strict();

export type { HostPatchRead };

export function readHostPatch(now: Date, path = HOST_PATCH_PATH, trustedUid = ROOT_UID): HostPatchRead {
  const parsed = summarySchema.safeParse(readHardenedJson(path, () => trustedUid, MAX_BYTES));
  if (!parsed.success) return { kind: 'unavailable' };
  const s = parsed.data;
  // An event newer than the summary itself would read as a negative age, i.e. healthy.
  const events = [s.reboot_required?.since, s.unattended.last_run, ...(s.stale_services ?? []).map((x) => x.since)];
  if (events.some((at) => typeof at === 'number' && at > s.timestamp)) return { kind: 'unavailable' };
  const age = now.getTime() / 1000 - s.timestamp;
  if (!Number.isFinite(age) || age < 0) return { kind: 'unavailable' };
  if (age > STALE_SECONDS) return { kind: 'stale' };
  return {
    kind: 'ok',
    facts: {
      timestamp: s.timestamp,
      kernel: s.kernel && { running: s.kernel.running, newestInstalled: s.kernel.newest_installed },
      rebootRequired: s.reboot_required,
      livepatch: s.livepatch && { state: s.livepatch.state, upgradeRequiredDate: s.livepatch.upgrade_required_date },
      staleServices: s.stale_services,
      unattended: { lastRun: s.unattended.last_run, securityPending: s.unattended.security_pending },
      packages: s.packages,
    },
  };
}

// Spec 2026-10-11 §10: the collector's image.json, next to the summary and in a file of its own, so the summary
// keeps the shape every release's strict reader accepts. Optional in every sense: missing, unreadable, malformed,
// stale or from the future is null — the report then has no image line, and the host-patch verdict never reads it.
const HOST_IMAGE_PATH = '/var/tmp/wbb-host-patch/image.json';
const IMAGE_MAX_BYTES = 4_096;
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const imageV1 = {
  timestamp: seconds,
  unit: z.enum(['quadlet', 'foreign', 'absent']).nullable(),
  running_digest: digest.nullable(),
  deployed_digest: digest.nullable(),
};
// Version 2 adds the deploy window's digests; version 1 (a collector from before them) still reads, without them.
const imageSchema = z.union([
  z.object({ version: z.literal(1), ...imageV1 }).strict(),
  z.object({
    version: z.literal(2), ...imageV1, window_digest: digest.nullable(), window_prev_digest: digest.nullable(),
  }).strict(),
]);

export function readHostImage(now: Date, path = HOST_IMAGE_PATH, trustedUid = ROOT_UID): ImageFacts | null {
  const parsed = imageSchema.safeParse(readHardenedJson(path, () => trustedUid, IMAGE_MAX_BYTES));
  if (!parsed.success) return null;
  const s = parsed.data;
  const age = now.getTime() / 1000 - s.timestamp;
  if (!Number.isFinite(age) || age < 0 || age > STALE_SECONDS) return null;
  return {
    unit: s.unit, runningDigest: s.running_digest, deployedDigest: s.deployed_digest,
    windowDigest: s.version === 2 ? s.window_digest : null, windowPrevDigest: s.version === 2 ? s.window_prev_digest : null,
  };
}
