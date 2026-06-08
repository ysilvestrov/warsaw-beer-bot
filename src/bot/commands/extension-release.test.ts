import { createHash } from 'node:crypto';
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import {
  upsertRelease,
  getReleaseByVersion,
  attachFileId,
} from '../../storage/extension_releases';
import { handleReleaseDocument, broadcastRelease } from './extension-release';

function ctxFor(opts: { fromId: number; adminId?: string; fileName: string }) {
  const replies: Array<{ text: string; extra?: unknown }> = [];
  const db = openDb(':memory:');
  migrate(db);
  return {
    db,
    replies,
    ctx: {
      from: { id: opts.fromId },
      message: { document: { file_id: 'FID', file_name: opts.fileName } },
      deps: { db, env: { ADMIN_TELEGRAM_ID: opts.adminId } },
      t: (k: string, p?: Record<string, unknown>) => `${k}:${JSON.stringify(p ?? {})}`,
      telegram: {
        getFileLink: async () => new URL('https://example/file'),
      },
      reply: async (text: string, extra?: unknown) => {
        replies.push({ text, extra });
      },
    },
  };
}

describe('handleReleaseDocument', () => {
  const origFetch = global.fetch;
  afterEach(() => {
    global.fetch = origFetch;
  });

  it('passes through (next) when the sender is not the admin', async () => {
    const h = ctxFor({ fromId: 5, adminId: '999', fileName: 'warsaw-beer-overlay-0.2.0.zip' });
    let nexted = false;
    await handleReleaseDocument(h.ctx as never, async () => {
      nexted = true;
    });
    expect(nexted).toBe(true);
    expect(h.replies).toHaveLength(0);
  });

  it('passes through (next) for a non-release filename from the admin', async () => {
    const h = ctxFor({ fromId: 7, adminId: '7', fileName: 'untappd-export.zip' });
    let nexted = false;
    await handleReleaseDocument(h.ctx as never, async () => {
      nexted = true;
    });
    expect(nexted).toBe(true);
  });

  it('rejects when the uploaded hash matches no latest release', async () => {
    const h = ctxFor({ fromId: 7, adminId: '7', fileName: 'warsaw-beer-overlay-0.2.0.zip' });
    upsertRelease(h.db, { version: '0.2.0', sha256: 'DIFFERENT', notes: 'n' });
    global.fetch = (async () => ({ arrayBuffer: async () => Buffer.from('zip') })) as never;
    await handleReleaseDocument(h.ctx as never, async () => {});
    expect(h.replies[0].text).toContain('extrel.no_match');
    expect(getReleaseByVersion(h.db, '0.2.0')!.file_id).toBeNull();
  });

  it('attaches file_id + shows the broadcast keyboard on a hash match', async () => {
    const bytes = Buffer.from('the-real-zip');
    const sha = createHash('sha256').update(bytes).digest('hex');
    const h = ctxFor({ fromId: 7, adminId: '7', fileName: 'warsaw-beer-overlay-0.2.0.zip' });
    upsertRelease(h.db, { version: '0.2.0', sha256: sha, notes: 'n' });
    global.fetch = (async () => ({ arrayBuffer: async () => bytes })) as never;
    await handleReleaseDocument(h.ctx as never, async () => {});
    expect(getReleaseByVersion(h.db, '0.2.0')!.file_id).toBe('FID');
    expect(h.replies[0].text).toContain('extrel.attached');
    expect(h.replies[0].extra).toBeDefined(); // inline keyboard present
  });
});

function seedToken(db: ReturnType<typeof openDb>, id: number, lang?: string) {
  db.prepare('INSERT OR IGNORE INTO user_profiles (telegram_id, language) VALUES (?, ?)').run(
    id,
    lang ?? null,
  );
  db.prepare('INSERT INTO api_tokens (token_hash, telegram_id, created_at) VALUES (?, ?, ?)').run(
    `h-${id}`,
    id,
    '2026-06-08T00:00:00Z',
  );
}

describe('broadcastRelease', () => {
  it('sends notes + document to every token holder and counts failures', async () => {
    const db = openDb(':memory:');
    migrate(db);
    upsertRelease(db, { version: '0.2.0', sha256: 's', notes: 'changelog body' });
    attachFileId(db, '0.2.0', 'FID', 1);
    seedToken(db, 1, 'en');
    seedToken(db, 2, 'uk');

    const sentDocs: Array<{ chat: number; fileId: string }> = [];
    const telegram = {
      sendMessage: async (chat: number) => {
        if (chat === 2) throw new Error('blocked');
      },
      sendDocument: async (chat: number, fileId: string) => {
        sentDocs.push({ chat, fileId });
      },
    };

    const result = await broadcastRelease(telegram as never, db, '0.2.0');
    expect(result).toEqual({ sent: 1, failed: 1 });
    expect(sentDocs).toEqual([{ chat: 1, fileId: 'FID' }]);
  });
});
