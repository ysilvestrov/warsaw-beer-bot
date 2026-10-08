import type { Avail, HostPatchFacts } from './types';
import { STATUS_RULES as R } from './rules';
import { ukDays } from './helpers';

// Host-patch findings for the Інфраструктура row (#469 stage 2). Independent of the disk monitor:
// the periphery merges them into evaluateInfra so an unreadable disk summary cannot hide them.
export type HostFinding = { colour: 'yellow' | 'red'; reason: string };
const red = (reason: string): HostFinding => ({ colour: 'red', reason });
const yellow = (reason: string): HostFinding => ({ colour: 'yellow', reason });

const DAY = 86_400;
const LIVEPATCH_OK: readonly string[] = ['applied', 'nothing-to-apply'];
// needrestart defers everything else on purpose (code-server, dbus, logind, getty…); those
// refresh only on reboot, which the reboot rule already covers.
export const WATCHED_UNITS: readonly string[] = [
  'warsaw-beer-bot.service', 'cloudflared.service', 'litestream.service', 'ssh.service',
];

// Whole days from now to the start of `date` (UTC), or null for anything that is not a real date.
function daysUntil(date: string, nowSeconds: number): number | null {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(t)
    || new Date(t).toISOString().slice(0, 10) !== date) return null;
  return Math.floor((t / 1000 - nowSeconds) / DAY);
}

function ubuntuSupport(nowSeconds: number): HostFinding[] {
  const left = daysUntil(R.ubuntuStandardSupportEnd, nowSeconds)!;
  const text = `Ubuntu 24.04: стандартна підтримка до ${R.ubuntuStandardSupportEnd} — ${
    left < 0 ? 'уже минула' : `лишилось ${ukDays(left)}`}`;
  if (left < R.eolRedDays) return [red(text)];
  if (left < R.eolYellowDays) return [yellow(text)];
  return [];
}

export function hostPatchFindings(hp: Avail<HostPatchFacts>, now: Date): HostFinding[] {
  const t = Math.floor(now.getTime() / 1000);
  const f: HostFinding[] = ubuntuSupport(t);
  if (!hp.ok) return [...f, yellow(`нема даних: ${hp.reason}`)];
  const h = hp.value;

  if (h.rebootRequired !== null) {
    const age = t - h.rebootRequired.since;
    const pk = h.rebootRequired.packages;
    const list = pk.length === 0 ? '' : ` (${pk.slice(0, 3).join(', ')}${pk.length > 3 ? ', …' : ''})`;
    const text = `ядро: перезавантаження чекає ${ukDays(Math.floor(age / DAY))}${list}`;
    if (age > R.rebootRedDays * DAY) f.push(red(text));
    else if (age > R.rebootYellowDays * DAY) f.push(yellow(text));
  }

  if (h.livepatch === null) f.push(yellow('нема даних: стан Livepatch'));
  else {
    if (!LIVEPATCH_OK.includes(h.livepatch.state)) f.push(yellow(`Livepatch: ${h.livepatch.state}`));
    const end = h.livepatch.upgradeRequiredDate;
    if (end !== null) {
      const left = daysUntil(end, t);
      if (left === null) f.push(yellow('нема даних: дата підтримки ядра в Livepatch'));
      else if (left < 0) f.push(red(`Livepatch більше не покриває ядро (з ${end})`));
      else if (left < R.livepatchSupportYellowDays) f.push(yellow(`Livepatch покриває ядро лише до ${end}`));
    }
  }

  if (h.staleServices === null) f.push(yellow('нема даних: needrestart'));
  else {
    for (const s of h.staleServices.filter((x) => WATCHED_UNITS.includes(x.unit))) {
      const age = t - s.since;
      if (age > R.staleServiceYellowDays * DAY) {
        f.push(yellow(`${s.unit} не перезапущено після оновлення бібліотек: ${ukDays(Math.floor(age / DAY))}`));
      }
    }
  }

  const u = h.unattended;
  if (u.securityPending === null) f.push(yellow('нема даних: безпекові оновлення'));
  else if (u.securityPending > 0) {
    if (u.lastRun === null) {
      f.push(yellow(`безпекових оновлень чекає ${u.securityPending}, unattended-upgrades ще не запускався`));
    } else if (t - u.lastRun > R.unattendedStaleYellowDays * DAY) {
      f.push(yellow(`безпекових оновлень чекає ${u.securityPending}, unattended-upgrades не запускався ${
        ukDays(Math.floor((t - u.lastRun) / DAY))}`));
    }
  }
  return f;
}
