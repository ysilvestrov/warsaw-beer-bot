import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { promises as fsp } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import pino from 'pino';
import { createTriageArchive } from './triage-archive';

const log = pino({ level: 'silent' });
let dir: string;

beforeEach(async () => {
  dir = await fsp.mkdtemp(join(tmpdir(), 'triage-archive-'));
});
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

test('returns null when dir is empty', () => {
  expect(createTriageArchive({ dir: '' }, log)).toBeNull();
  expect(createTriageArchive({ dir: '   ' }, log)).toBeNull();
});

test('writes a dated JSON file with the payload', async () => {
  const archive = createTriageArchive({ dir }, log)!;
  await archive.write('2026-07-14', { hello: 'world' });
  const content = await fsp.readFile(join(dir, '2026-07-14.json'), 'utf8');
  expect(JSON.parse(content)).toEqual({ hello: 'world' });
});

test('rotation keeps only the newest `keep` files by date name', async () => {
  const archive = createTriageArchive({ dir, keep: 3 }, log)!;
  for (const day of ['10', '11', '12', '13', '14']) {
    await archive.write(`2026-07-${day}`, { day });
  }
  const files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  expect(files).toEqual(['2026-07-12.json', '2026-07-13.json', '2026-07-14.json']);
});

test('fs error is swallowed as a warn, never throws', async () => {
  const warn = vi.fn();
  const failingLog = { warn } as unknown as pino.Logger;
  const badFs = {
    mkdir: vi.fn().mockRejectedValue(new Error('disk full')),
    writeFile: vi.fn(),
    readdir: vi.fn(),
    rm: vi.fn(),
  };
  const archive = createTriageArchive({ dir }, failingLog, badFs as never)!;
  await expect(archive.write('2026-07-14', {})).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalledTimes(1);
});
