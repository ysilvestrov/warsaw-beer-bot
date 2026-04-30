import { Readable } from 'node:stream';
import { parse as csvParse } from 'csv-parse';
// stream-json v2 exports: { "./*": "./src/*" } — Node applies the mapping
// but does NOT append `.js` afterwards, so the require path must be explicit.
// ts-jest resolves without the suffix, so tests passed while `node dist/...`
// failed at module load.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const streamArray: typeof import('stream-json/src/streamers/stream-array') =
  require('stream-json/streamers/stream-array.js');
import yauzl from 'yauzl';

export interface Checkin {
  checkin_id: string;
  bid: number | null;
  beer_name: string;
  brewery_name: string;
  beer_type: string | null;
  beer_abv: number | null;
  rating_score: number | null;
  global_rating: number | null;
  created_at: string;
  venue_name: string | null;
}

export type ExportFormat = 'csv' | 'json' | 'zip';

export function detectFormat(filename: string): ExportFormat {
  const n = filename.toLowerCase();
  if (n.endsWith('.zip')) return 'zip';
  if (n.endsWith('.json')) return 'json';
  if (n.endsWith('.csv')) return 'csv';
  throw new Error(`Unsupported export format: ${filename}`);
}

export async function* iterExport(
  input: Readable,
  format: ExportFormat,
): AsyncGenerator<Checkin> {
  if (format === 'zip') {
    const inner = await openInnerFromZip(input);
    yield* iterExport(inner.stream, inner.format);
    return;
  }
  if (format === 'csv') {
    const parser = input.pipe(csvParse({ columns: true, skip_empty_lines: true, trim: true }));
    for await (const r of parser) yield mapCsv(r as Record<string, string>);
    return;
  }
  const pipeline = input.pipe(streamArray.withParserAsStream());
  for await (const chunk of pipeline as AsyncIterable<{ key: number; value: Record<string, unknown> }>) {
    yield mapJson(chunk.value);
  }
}

function mapCsv(r: Record<string, string>): Checkin {
  return {
    checkin_id: r['checkin_id'],
    bid: numOrNull(r['bid']),
    beer_name: r['beer_name'],
    brewery_name: r['brewery_name'],
    beer_type: blankNull(r['beer_type']),
    beer_abv: numOrNull(r['beer_abv']),
    rating_score: numOrNull(r['rating_score']),
    global_rating: numOrNull(r['global_weighted_rating_score']),
    created_at: r['created_at'],
    venue_name: blankNull(r['venue_name']),
  };
}

function mapJson(r: Record<string, unknown>): Checkin {
  return {
    checkin_id: String(r['checkin_id']),
    bid: numOrNull(r['bid']),
    beer_name: String(r['beer_name'] ?? ''),
    brewery_name: String(r['brewery_name'] ?? ''),
    beer_type: blankNull(r['beer_type']),
    beer_abv: numOrNull(r['beer_abv']),
    rating_score: numOrNull(r['rating_score']),
    global_rating: numOrNull(r['global_weighted_rating_score']),
    created_at: String(r['created_at'] ?? ''),
    venue_name: blankNull(r['venue_name']),
  };
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function blankNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

async function streamToBuffer(rs: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of rs) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

function openInnerFromZip(
  input: Readable,
): Promise<{ stream: Readable; format: 'csv' | 'json' }> {
  return streamToBuffer(input).then(
    (buf) =>
      new Promise((resolve, reject) => {
        yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
          if (err || !zip) return reject(err ?? new Error('bad zip'));
          zip.on('error', reject);
          zip.on('entry', (entry) => {
            if (entry.fileName.endsWith('/')) { zip.readEntry(); return; }
            const name = entry.fileName.toLowerCase();
            const fmt = name.endsWith('.json') ? 'json' : name.endsWith('.csv') ? 'csv' : null;
            if (!fmt) { zip.readEntry(); return; }
            zip.openReadStream(entry, (e, rs) => {
              if (e || !rs) return reject(e ?? new Error('zip entry unreadable'));
              resolve({ stream: rs, format: fmt });
            });
          });
          zip.on('end', () => reject(new Error('ZIP has no .csv or .json entry')));
          zip.readEntry();
        });
      }),
  );
}
