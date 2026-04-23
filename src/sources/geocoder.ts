export interface Coords { lat: number; lon: number; }

export type Geocoder = (address: string) => Promise<Coords | null>;

export function createGeocoder(opts: { userAgent: string; fetchImpl?: typeof fetch }): Geocoder {
  const f = opts.fetchImpl ?? fetch;
  return async (address) => {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`;
    const res = await f(url, { headers: { 'User-Agent': opts.userAgent } });
    if (!res.ok) throw new Error(`geocoder HTTP ${res.status}`);
    const body = (await res.json()) as { lat: string; lon: string }[];
    if (!body.length) return null;
    return { lat: parseFloat(body[0].lat), lon: parseFloat(body[0].lon) };
  };
}
