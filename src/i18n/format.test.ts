import { fmtAbv, fmtKm } from './format';

describe('fmtAbv', () => {
  test('null → empty', () => {
    expect(fmtAbv('uk', null)).toBe('');
    expect(fmtAbv('en', null)).toBe('');
  });

  test('uk uses comma decimal', () => {
    expect(fmtAbv('uk', 6.1)).toBe('  ·  6,1%');
  });

  test('pl uses comma decimal', () => {
    expect(fmtAbv('pl', 4.5)).toBe('  ·  4,5%');
  });

  test('en uses dot decimal', () => {
    expect(fmtAbv('en', 6.1)).toBe('  ·  6.1%');
  });

  test('integer ABV — no separator at all', () => {
    expect(fmtAbv('uk', 7.0)).toBe('  ·  7%');
    expect(fmtAbv('en', 7.0)).toBe('  ·  7%');
  });
});

describe('fmtKm', () => {
  test('uk uses comma + км', () => {
    expect(fmtKm('uk', 14400)).toBe('14,4 км');
  });

  test('pl uses comma + km', () => {
    expect(fmtKm('pl', 14400)).toBe('14,4 km');
  });

  test('en uses dot + km', () => {
    expect(fmtKm('en', 14400)).toBe('14.4 km');
  });

  test('rounds to one decimal', () => {
    expect(fmtKm('en', 12345)).toBe('12.3 km');
    expect(fmtKm('uk', 1050)).toBe('1,1 км');
  });
});
