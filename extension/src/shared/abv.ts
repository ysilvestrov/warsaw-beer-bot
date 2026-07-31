// #369: the client-side mirror of the server's sanitizeAbv. Applied once, where a
// Card's shop-published ABV enters a payload, so it covers every adapter and both the
// /match and /enrich/* paths rather than being re-implemented per shop.
//
// Two reasons it exists on the client too:
//   - /match has no server-side sanitizer, so an absurd shop ABV would otherwise reach
//     the matcher and skew or block a match that would have succeeded without it.
//   - JSON.stringify turns NaN/Infinity into null, and a null would be rejected at the
//     schema layer — dropping the field here keeps one bad card from spoiling a batch.
//
// 0 is a legitimate value and must survive: it is the only thing separating AleBrowar's
// Kwas Chlebowy Bright (0.0%) from Light (0.5%) (#322). Never test this for truthiness.
// The upper bound is a garbage filter, not a domain limit — freeze-distilled beers
// reach ~67%.
export function usableAbv(abv: number | undefined): number | undefined {
  if (abv === undefined) return undefined;
  if (!Number.isFinite(abv)) return undefined;
  if (abv < 0 || abv > 100) return undefined;
  return abv;
}
