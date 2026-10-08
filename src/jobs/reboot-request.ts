import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// #469 stage 3: the bot ASKS for a reboot; root acts (scripts/ops/reboot_request.py, run by
// wbb-reboot-request.path on PathChanged). Temp file + rename: the handler never sees a half
// write, and PathChanged fires on the rename (spec C21).
export const REBOOT_REQUEST_DIR = '/var/lib/wbb-host-patch';
export type RebootKind = 'now' | '0400';

export function writeRebootRequest(kind: RebootKind, now: Date, dir = REBOOT_REQUEST_DIR): void {
  const temp = join(dir, `.reboot-request.${process.pid}`);
  writeFileSync(temp, `${kind} ${Math.floor(now.getTime() / 1000)}\n`, { mode: 0o600 });
  renameSync(temp, join(dir, 'reboot-request'));
}
