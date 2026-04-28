import { formatRouteResult, type RoutePubFormat } from './route-format';
import type { Translator } from '../../i18n/types';

const stubT: Translator = (key, params) => {
  if (key === 'route.header') {
    return `Знайдено маршрут для <b>${params!.count}</b> (чи більше) нових пив, відстань ≈ <b>${params!.km}</b>, пабів у маршруті: <b>${params!.pubs}</b>.`;
  }
  return String(key);
};

const beerBones: RoutePubFormat = {
  name: 'Beer & Bones',
  beers: [
    { display: 'Pinta Atak Chmielu', rating: 4.12, abv: 6.1 },
    { display: 'Browar Stu Mostów Salamander', rating: null, abv: 4.5 },
  ],
};

const cuda: RoutePubFormat = {
  name: 'Cuda na Kiju',
  beers: [
    { display: 'AleBrowar IPA', rating: 3.9, abv: 6.0 },
  ],
};

describe('formatRouteResult', () => {
  test('header uses requested phrasing', () => {
    const out = formatRouteResult({
      N: 10,
      distanceMeters: 14400,
      pubsInOrder: [beerBones, cuda],
      locale: 'uk',
      t: stubT,
    });
    const firstLine = out.split('\n')[0];
    expect(firstLine).toContain('Знайдено маршрут для');
    expect(firstLine).toContain('10');
    expect(firstLine).toContain('(чи більше) нових пив');
    expect(firstLine).toContain('14,4 км');
    expect(firstLine).toContain('пабів');
    expect(firstLine).toContain('2');
  });

  test('lists each pub in order, numbered, bold', () => {
    const out = formatRouteResult({
      N: 5,
      distanceMeters: 1000,
      pubsInOrder: [beerBones, cuda],
      locale: 'uk',
      t: stubT,
    });
    expect(out).toContain('<b>1. Beer &amp; Bones</b>');
    expect(out).toContain('<b>2. Cuda na Kiju</b>');
    const idx1 = out.indexOf('<b>1. Beer');
    const idx2 = out.indexOf('<b>2. Cuda');
    expect(idx1).toBeLessThan(idx2);
  });

  test('per pub lists beers in /newbeers style — bold display + rating + abv', () => {
    const out = formatRouteResult({
      N: 5,
      distanceMeters: 1000,
      pubsInOrder: [beerBones],
      locale: 'uk',
      t: stubT,
    });
    expect(out).toContain('<b>Pinta Atak Chmielu</b>');
    expect(out).toContain('⭐ 4.12');
    expect(out).toContain('6,1%');
    expect(out).toContain('<b>Browar Stu Mostów Salamander</b>');
    expect(out).toContain('⭐ —');
    expect(out).toContain('4,5%');
  });

  test('escapes HTML in pub and beer names', () => {
    const out = formatRouteResult({
      N: 1,
      distanceMeters: 0,
      pubsInOrder: [{
        name: '<Pub>',
        beers: [{ display: 'A & B <c>', rating: null, abv: null }],
      }],
      locale: 'uk',
      t: stubT,
    });
    expect(out).toContain('&lt;Pub&gt;');
    expect(out).toContain('A &amp; B &lt;c&gt;');
    expect(out).not.toMatch(/<Pub>/);
  });

  test('formats distance with one decimal', () => {
    const out = formatRouteResult({
      N: 1,
      distanceMeters: 12345,
      pubsInOrder: [beerBones],
      locale: 'uk',
      t: stubT,
    });
    expect(out).toContain('12,3 км');
  });

  test('handles empty per-pub beer list gracefully', () => {
    const out = formatRouteResult({
      N: 1,
      distanceMeters: 0,
      pubsInOrder: [{ name: 'X', beers: [] }],
      locale: 'uk',
      t: stubT,
    });
    expect(out).toContain('<b>1. X</b>');
  });
});
