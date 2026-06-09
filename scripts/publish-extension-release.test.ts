import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReleaseRow, writeReleaseRow, stageZip } from './publish-extension-release';
import { openDb } from '../src/storage/db';
import { migrate } from '../src/storage/schema';
import { getReleaseByVersion } from '../src/storage/extension_releases';

describe('buildReleaseRow', () => {
  it('computes sha256 of the zip and pairs version + notes', () => {
    const zip = Buffer.from('fake-zip-bytes');
    const row = buildReleaseRow({ version: '0.2.0', zip, notes: 'hello\n' });
    expect(row).toEqual({
      version: '0.2.0',
      sha256: createHash('sha256').update(zip).digest('hex'),
      notes: 'hello',
    });
  });
});

describe('writeReleaseRow', () => {
  it('writes in-process when the DB is writable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rel-'));
    const dbPath = join(dir, 'bot.db');
    const seed = openDb(dbPath);
    migrate(seed);
    seed.close();

    const how = writeReleaseRow(
      dbPath,
      { version: '0.2.0', sha256: 'abc', notes: 'note' },
      { isWritable: () => true },
    );
    expect(how).toBe('in-process');

    const db = openDb(dbPath);
    expect(getReleaseByVersion(db, '0.2.0')!.sha256).toBe('abc');
    db.close();
  });

  it('delegates to the helper when the DB is not writable', () => {
    const calls: string[][] = [];
    const how = writeReleaseRow(
      '/var/lib/warsaw-beer-bot/bot.db',
      { version: '0.2.0', sha256: 'deadbeef', notes: 'release notes' },
      {
        isWritable: () => false,
        helperPath: '/usr/local/bin/apply-extension-release.sh',
        runHelper: (helper, version, sha, notes) => calls.push([helper, version, sha, notes]),
      },
    );
    expect(how).toBe('helper');
    expect(calls).toEqual([
      ['/usr/local/bin/apply-extension-release.sh', '0.2.0', 'deadbeef', 'release notes'],
    ]);
  });
});

describe('stageZip', () => {
  it('copies the zip into the staging dir under the versioned name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stage-'));
    const zipPath = join(dir, 'built.zip');
    writeFileSync(zipPath, 'zip-bytes');
    const stageDir = join(dir, 'out');

    const dest = stageZip(zipPath, '0.2.0', stageDir);
    expect(dest).toBe(join(stageDir, 'warsaw-beer-overlay-0.2.0.zip'));
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, 'utf8')).toBe('zip-bytes');
  });
});
