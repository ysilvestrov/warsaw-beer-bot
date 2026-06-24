import { googleMapsWalkingUrl, type Coord } from './maps';

const A: Coord = { lat: 52.1, lon: 21.0 };
const B: Coord = { lat: 52.2, lon: 21.1 };
const C: Coord = { lat: 52.3, lon: 21.2 };

describe('googleMapsWalkingUrl', () => {
  it('returns null for no stops', () => {
    expect(googleMapsWalkingUrl([])).toBeNull();
  });

  it('uses destination-only (start = user location) for a single stop', () => {
    const url = googleMapsWalkingUrl([A])!;
    expect(url).toContain('destination=52.100000,21.000000');
    expect(url).not.toContain('origin=');
    expect(url).not.toContain('waypoints=');
    expect(url).toContain('travelmode=walking');
  });

  it('uses origin + destination and no waypoints for two stops', () => {
    const url = googleMapsWalkingUrl([A, B])!;
    expect(url).toContain('origin=52.100000,21.000000');
    expect(url).toContain('destination=52.200000,21.100000');
    expect(url).not.toContain('waypoints=');
  });

  it('puts the middle stops into waypoints for three stops', () => {
    const url = googleMapsWalkingUrl([A, B, C])!;
    expect(url).toContain('origin=52.100000,21.000000');
    expect(url).toContain('destination=52.300000,21.200000');
    expect(url).toContain('waypoints=52.200000,21.100000');
  });

  it('url-encodes the waypoint separator', () => {
    const D: Coord = { lat: 52.4, lon: 21.3 };
    const url = googleMapsWalkingUrl([A, B, C, D])!;
    // two middle stops B,C joined by encoded pipe
    expect(url).toContain('waypoints=52.200000,21.100000%7C52.300000,21.200000');
  });

  it('caps intermediate waypoints at 9, keeping true first/last', () => {
    // 12 stops => 10 middle => capped to 9 waypoints
    const stops: Coord[] = Array.from({ length: 12 }, (_, i) => ({
      lat: 50 + i,
      lon: 20 + i,
    }));
    const url = googleMapsWalkingUrl(stops)!;
    expect(url).toContain('origin=50.000000,20.000000');
    expect(url).toContain('destination=61.000000,31.000000');
    const wp = url.match(/waypoints=([^&]*)/)![1];
    expect(wp.split('%7C')).toHaveLength(9);
  });
});
