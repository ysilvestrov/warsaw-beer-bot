import { ukDays } from './helpers';
import type { HostPatchRead } from './types';

// #469 stage 3 — one alert per pending reboot (keyed by reboot_required.since, which the collector
// carries forward and resets only at boot, C19/C23), and one more after each snooze expires.
export interface RebootAlertState { since: number; snoozeUntil: number | null } // unix seconds
export type RebootDecision =
  | { send: true; text: string; state: RebootAlertState }
  | { send: false; state: RebootAlertState | null };
export const REBOOT_SNOOZE_SECONDS = 3 * 86_400;
const MAX_LISTED_PACKAGES = 10;

// Names the packages and never claims the kernel: under Livepatch, kernel packages do not set
// the reboot flag (C19), so what is pending here is a library such as libc6 or dbus.
function alertText(since: number, packages: string[], livepatch: string | null, nowSeconds: number): string {
  const days = Math.floor((nowSeconds - since) / 86_400);
  const waited = days >= 1 ? ` — чекає ${ukDays(days)}` : '';
  const shown = packages.slice(0, MAX_LISTED_PACKAGES).join(', ') + (packages.length > MAX_LISTED_PACKAGES ? ', …' : '');
  const list = packages.length === 0 ? '' : `: ${shown}`;
  return `🔁 Хосту потрібне перезавантаження${waited}${list}.\nLivepatch: ${livepatch ?? 'нема даних'}.`;
}

export function decideRebootAlert(hp: HostPatchRead, prev: RebootAlertState | null, now: Date): RebootDecision {
  // Unreadable: say nothing (the daily status already reports «нема даних») and forget nothing.
  if (hp.kind !== 'ok') return { send: false, state: prev };
  const pending = hp.facts.rebootRequired;
  if (pending === null) return { send: false, state: null };
  const t = Math.floor(now.getTime() / 1000);
  const fresh = prev === null || prev.since !== pending.since;
  // A stored snooze is a claim: only snoozeRebootAlertNow writes it, never further than 3 days
  // ahead, so a later one is corrupt and must not silence a pending reboot (AI review, #807).
  const snoozeOver = !fresh && prev!.snoozeUntil !== null
    && (t >= prev!.snoozeUntil || prev!.snoozeUntil > t + REBOOT_SNOOZE_SECONDS);
  if (!fresh && !snoozeOver) return { send: false, state: prev };
  return {
    send: true,
    text: alertText(pending.since, pending.packages, hp.facts.livepatch?.state ?? null, t),
    state: { since: pending.since, snoozeUntil: null },
  };
}

export function snoozeRebootAlert(state: RebootAlertState, now: Date): RebootAlertState {
  return { ...state, snoozeUntil: Math.floor(now.getTime() / 1000) + REBOOT_SNOOZE_SECONDS };
}
