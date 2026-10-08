import type { HostPatchFacts, HostUpstream } from './types';
import type { HostFinding } from './host-patch';
import { calendarDaysUntil } from './host-patch';
import { STATUS_RULES as R } from './rules';
import { ukDays } from './helpers';
import { compareVersions } from '../../sources/cws-version';

// Upstream rows of the host-patch rules (#469 stage 2). Node's end of life does not depend on the
// host summary and is reported even when it is unreadable; the version rules need `packages`.
const red = (reason: string): HostFinding => ({ colour: 'red', reason });
const yellow = (reason: string): HostFinding => ({ colour: 'yellow', reason });

// "24.21.0-1nodesource1" → "24.21.0", "1:2.39-0ubuntu8.7" → "2.39": the epoch and the Debian
// revision say nothing about which upstream release is installed.
export function debianUpstreamVersion(raw: string): string | null {
  const m = /^(?:\d+:)?(\d+(?:\.\d+)*)(?:[-+~].*)?$/.exec(raw);
  return m ? m[1] : null;
}

export function upstreamFindings(
  u: HostUpstream, packages: HostPatchFacts['packages'] | null, now: Date,
): HostFinding[] {
  const t = Math.floor(now.getTime() / 1000);
  const f: HostFinding[] = [];
  const ago = (date: string): number => -calendarDaysUntil(date, t)!;

  if (!u.nodeEnd.ok) f.push(yellow(`нема даних: ${u.nodeEnd.reason}`));
  else {
    const left = calendarDaysUntil(u.nodeEnd.value, t)!;
    const text = `Node 24: підтримка до ${u.nodeEnd.value} — ${left < 0 ? 'уже минула' : `лишилось ${ukDays(left)}`}`;
    if (left < R.eolRedDays) f.push(red(text));
    else if (left < R.eolYellowDays) f.push(yellow(text));
  }

  if (!u.nodeSecurity.ok) f.push(yellow(`нема даних: ${u.nodeSecurity.reason}`));
  else if (u.nodeSecurity.value !== null && packages !== null) {
    const installed = packages.nodejs === null ? null : debianUpstreamVersion(packages.nodejs);
    const sec = u.nodeSecurity.value;
    if (installed === null) f.push(yellow('нема даних: встановлена версія nodejs'));
    else if (compareVersions(installed, sec.version) < 0 && ago(sec.date) > R.nodeSecurityRedDays) {
      f.push(red(`Node ${installed} < безпековий ${sec.version} (з ${sec.date})`));
    }
  }

  if (!u.litestream.ok) f.push(yellow(`нема даних: ${u.litestream.reason}`));
  else if (packages !== null) {
    const installed = packages.litestream === null ? null : debianUpstreamVersion(packages.litestream);
    const latest = u.litestream.value;
    const day = latest.publishedAt.slice(0, 10);
    if (installed === null) f.push(yellow('нема даних: встановлена версія litestream'));
    else if (compareVersions(installed, latest.version) < 0 && ago(day) > R.litestreamYellowDays) {
      f.push(yellow(`litestream ${installed} < ${latest.version} (вийшов ${day})`));
    }
  }
  return f;
}
