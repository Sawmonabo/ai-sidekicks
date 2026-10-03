// The one definition of "canonical UUID form": a map keyed by a UUID routes its lowercasing
// through `canonicalizeUuid`, so "canonical" means one thing repo-wide.

/**
 * Lowercases a UUID, keeping its brand. The branded-UUID schemas accept any case, so a UUID used
 * as a map key or hash input passes through here first, or two spellings of one id split state.
 */
export function canonicalizeUuid<T extends string>(value: T): T {
  // Lowercasing never changes which id the value names. The schemas cannot normalize, since ids
  // are also branded by casts at database-row reads, which a schema transform never sees.
  return value.toLowerCase() as T;
}
