import { describe, it, expect } from 'vitest';
import { extractNotes } from './release-notes';

const CHANGELOG = `# Changelog

## [0.2.0] - 2026-06-09

- Added Bierloods22 adapter.
- Fixed badge flicker on SPA re-render.

## [0.1.0] - 2026-06-08

- Initial beta.
`;

describe('extractNotes', () => {
  it('returns the body of the matching version section, trimmed', () => {
    expect(extractNotes(CHANGELOG, '0.2.0')).toBe(
      '- Added Bierloods22 adapter.\n- Fixed badge flicker on SPA re-render.',
    );
  });

  it('returns the last section when it is the target', () => {
    expect(extractNotes(CHANGELOG, '0.1.0')).toBe('- Initial beta.');
  });

  it('throws when the version section is missing', () => {
    expect(() => extractNotes(CHANGELOG, '9.9.9')).toThrow(/no section for 9\.9\.9/);
  });

  it('throws when the section body is empty', () => {
    expect(() => extractNotes('## [1.0.0] - 2026-01-01\n\n## [0.9.0] - x\n- y', '1.0.0')).toThrow(
      /empty/,
    );
  });
});
