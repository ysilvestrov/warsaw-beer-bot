import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

// Linux operator telemetry written atomically by another account. Pin the opened directory while
// reading its replaced file, and treat every missing or suspicious input as unknown (undefined):
// the directory must be mode 0755 and owned by trustedUid(), the file a regular 0644 file with one
// link, the same owner and at most maxBytes. trustedUid is called only once the file is open.
export function readHardenedJson(path: string, trustedUid: () => number, maxBytes: number): unknown {
  let directory: number | undefined;
  let file: number | undefined;
  try {
    const parent = dirname(resolve(path));
    if (realpathSync(parent) !== parent) return undefined;
    directory = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const dirInfo = fstatSync(directory);
    if ((dirInfo.mode & 0o777) !== 0o755) return undefined;
    file = openSync(`/proc/self/fd/${directory}/${basename(path)}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(file);
    const owner = trustedUid();
    if (!Number.isSafeInteger(owner) || owner < 0 || dirInfo.uid !== owner) return undefined;
    if (!info.isFile() || info.uid !== dirInfo.uid || info.nlink !== 1
      || (info.mode & 0o777) !== 0o644 || info.size > maxBytes) return undefined;
    const buffer = Buffer.alloc(maxBytes);
    const count = readSync(file, buffer, 0, maxBytes, 0);
    if (count !== info.size || fstatSync(file).size !== info.size) return undefined;
    return JSON.parse(buffer.toString('utf8', 0, count)) as unknown;
  } catch {
    return undefined;
  } finally {
    let closeFailed = false;
    for (const fd of [file, directory]) {
      if (fd !== undefined) {
        try { closeSync(fd); }
        catch { closeFailed = true; }
      }
    }
    // A return in finally overrides the try's value: a failed close makes the read unknown.
    if (closeFailed) return undefined;
  }
}
