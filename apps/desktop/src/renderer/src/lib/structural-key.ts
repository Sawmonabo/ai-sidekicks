// One string standing for a tuple of free-form segments, and never for two tuples.
//
// Joining segments on a separator is injective only while no segment contains it, and the
// segments keyed on are wire strings (repository paths, server names the person typed, provider
// limit identifiers). `JSON.stringify` over the array is injective for string tuples, is total,
// and separates arity, so a tuple with an empty third segment differs from a two-segment one.
//
// It is a `Map` key and a React `key`, not a hash or identifier: nothing decodes or displays it.

/**
 * The one string that identifies this tuple of segments. Order is part of the identity and is
 * not sorted here, so callers keep a fixed order.
 */
export function structuralKey(segments: readonly string[]): string {
  return JSON.stringify(segments);
}
