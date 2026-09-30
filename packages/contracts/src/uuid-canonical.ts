// The one definition of "canonical UUID form": a map keyed by a UUID routes its lowercasing
// through `canonicalizeUuid`, so "canonical" means one thing repo-wide.

/**
 * Canonicalize a UUID string to lowercase hex, preserving the brand. UUID hex is
 * case-insensitive (RFC 9562 section 4) and the branded-UUID schemas accept any case and
 * normalize nothing, so a UUID used as a Map key or hash input must pass through here first, or
 * two spellings of one id split or lose state. Producers should emit this form too.
 *
 * The `as T` cast is the one contained unsoundness: `toLowerCase()` returns an unbranded string,
 * and lowercasing never changes which id the value denotes. Callers get a brand-correct value
 * with no cast of their own. Normalization is not folded into `brandedUuidIdSchema` because ids
 * are also branded by casts at database-row reads, which a schema transform would never see.
 */
export function canonicalizeUuid<T extends string>(value: T): T {
  return value.toLowerCase() as T;
}
