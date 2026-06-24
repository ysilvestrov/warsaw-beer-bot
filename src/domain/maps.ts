export interface Coord {
  lat: number;
  lon: number;
}

// Google Maps consumer URL supports at most 9 intermediate waypoints.
const MAX_WAYPOINTS = 9;

function fmt(c: Coord): string {
  return `${c.lat.toFixed(6)},${c.lon.toFixed(6)}`;
}

// Builds a Google Maps walking-directions URL for the ordered stops.
// - 0 stops  -> null
// - 1 stop   -> destination only (Google starts from the user's location)
// - >=2 stops -> origin = first, destination = last, middle stops as waypoints
//   (capped at MAX_WAYPOINTS, keeping the true first/last).
export function googleMapsWalkingUrl(stops: Coord[]): string | null {
  if (stops.length === 0) return null;

  const base = 'https://www.google.com/maps/dir/?api=1';
  if (stops.length === 1) {
    return `${base}&destination=${fmt(stops[0])}&travelmode=walking`;
  }

  const origin = stops[0];
  const destination = stops[stops.length - 1];
  const middle = stops.slice(1, -1).slice(0, MAX_WAYPOINTS);

  const params = [`origin=${fmt(origin)}`, `destination=${fmt(destination)}`];
  if (middle.length) {
    params.push(`waypoints=${middle.map(fmt).join('%7C')}`);
  }
  params.push('travelmode=walking');

  return `${base}&${params.join('&')}`;
}
