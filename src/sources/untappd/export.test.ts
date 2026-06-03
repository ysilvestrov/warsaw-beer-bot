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

async function collectBuffer(fmt: 'csv', buf: Buffer) {
  const out = [];
  for await (const r of iterExport(Readable.from(buf), fmt)) out.push(r);
  return out;
}

test('parses CSV with a UTF-8 BOM (first column header not mangled)', async () => {
  const header = 'beer_name,brewery_name,beer_type,beer_abv,rating_score,created_at,venue_name,checkin_id,bid,global_weighted_rating_score';
  const body = 'Atak Chmielu,Pinta,AIPA,6.1,4.25,2024-01-01,Cuda,1234,567,3.85';
  const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${header}\n${body}\n`, 'utf8')]);
  const rows = await collectBuffer('csv', buf);
  expect(rows).toHaveLength(1);
  expect(rows[0].beer_name).toBe('Atak Chmielu');
  expect(rows[0].brewery_name).toBe('Pinta');
});

test('CSV without a beer_name column fails with a clear error, not a TypeError', async () => {
  // e.g. a semicolon-delimited export: the whole line parses as one column,
  // so beer_name is absent. Must surface a recognizable message.
  const buf = Buffer.from('beer_name;brewery_name;rating_score\nAtak Chmielu;Pinta;4.25\n', 'utf8');
  await expect(collectBuffer('csv', buf)).rejects.toThrow(/column/i);
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
