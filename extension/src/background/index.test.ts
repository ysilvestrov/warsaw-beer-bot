import { describe, it, expect } from 'vitest';
import { feedUrl } from './index';

describe('feedUrl', () => {
  it('page 1 (null cursor) is the full profile page', () => {
    expect(feedUrl('ysilvestrov', null)).toBe('https://untappd.com/user/ysilvestrov');
  });

  it('older pages use the more_feed XHR endpoint, not a ?max_id= query', () => {
    expect(feedUrl('ysilvestrov', '1577238079')).toBe(
      'https://untappd.com/profile/more_feed/ysilvestrov/1577238079?v2=true',
    );
  });

  it('encodes the username', () => {
    expect(feedUrl('a b/c', null)).toBe('https://untappd.com/user/a%20b%2Fc');
  });
});
