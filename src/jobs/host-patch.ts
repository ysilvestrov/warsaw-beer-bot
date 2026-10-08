import { z } from 'zod';
import type { HostPatchFacts } from '../domain/status/types';
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

export type HostPatchRead = { kind: 'ok'; facts: HostPatchFacts } | { kind: 'stale' } | { kind: 'unavailable' };

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
