import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionUsername } from './session-user';

const fixture = (name: string) => readFileSync(join(__dirname, '../../sources/untappd/__fixtures__', name), 'utf8');
const nav = (...hrefs: string[]) =>
  `<html><body>${hrefs.map((h) => `<a class="track-click" data-href=":user/profile" href="${h}">My Profile</a>`).join('')}</body></html>`;

describe('sessionUsername', () => {
  it('reads the signed-in user from the real page menus', () => {
    expect(sessionUsername(fixture('checkin-feed-page.html'))).toBe('ysilvestrov');
  });

  it('is null on the real signed-out home page', () => {
    expect(sessionUsername(fixture('signed-out-home.html'))).toBeNull();
  });

  it('lowercases the name', () => {
    expect(sessionUsername(nav('/user/WarsawBeer80', '/user/warsawbeer80'))).toBe('warsawbeer80');
  });

  it('decodes an escaped name', () => {
    expect(sessionUsername(nav('/user/caf%C3%A9'))).toBe('café');
  });

  it('is null when the menus name two different users', () => {
    expect(sessionUsername(nav('/user/alice', '/user/bob'))).toBeNull();
  });

  it('is null when a profile link does not point at /user/<name>', () => {
    expect(sessionUsername(nav('/user/alice', '/login'))).toBeNull();
    expect(sessionUsername(nav('/user/alice/checkin/1'))).toBeNull();
  });

  it('ignores /user/ links that are not the profile menu item', () => {
    expect(sessionUsername('<html><body><a href="/user/someone">Someone</a></body></html>')).toBeNull();
  });
});
