import { createHash } from 'node:crypto';
import { buildReleaseRow } from './publish-extension-release';

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
