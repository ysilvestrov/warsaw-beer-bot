import path from 'node:path';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { iterExport, detectFormat } from './export';

const fx = (n: string) => path.join(__dirname, '../../../tests/fixtures/untappd', n);

async function collect(fmt: 'csv' | 'json' | 'zip', file: string) {
  const stream = Readable.from(fs.readFileSync(file));
  const out = [];
  for await (const r of iterExport(stream, fmt)) out.push(r);
  return out;
}

test('detectFormat maps extensions', () => {
  expect(detectFormat('x.CSV')).toBe('csv');
  expect(detectFormat('x.json')).toBe('json');
  expect(detectFormat('x.zip')).toBe('zip');
  expect(() => detectFormat('x.txt')).toThrow();
});

test('parses CSV fixture', async () => {
  const rows = await collect('csv', fx('export.csv'));
  expect(rows).toHaveLength(2);
  expect(rows[0].checkin_id).toBe('1234');
  expect(rows[0].beer_name).toBe('Atak Chmielu');
  expect(rows[0].rating_score).toBe(4.25);
  expect(rows[1].venue_name).toBeNull();
});

test('parses JSON fixture with same shape as CSV', async () => {
  const rows = await collect('json', fx('export.json'));
  expect(rows).toHaveLength(2);
  expect(rows[0].checkin_id).toBe('1234');
  expect(rows[0].bid).toBe(567);
  expect(rows[1].venue_name).toBeNull();
});

test('parses ZIP fixture (unwraps inner json)', async () => {
  const rows = await collect('zip', fx('export.zip'));
  expect(rows).toHaveLength(2);
  expect(rows[0].beer_name).toBe('Atak Chmielu');
});

test('captures global_weighted_rating_score from CSV', async () => {
  const rows = await collect('csv', fx('export.csv'));
  expect(rows[0].global_rating).toBe(3.85);
  expect(rows[1].global_rating).toBeNull();
});

test('captures global_weighted_rating_score from JSON', async () => {
  const rows = await collect('json', fx('export.json'));
  expect(rows[0].global_rating).toBe(3.85);
  expect(rows[1].global_rating).toBeNull();
});
