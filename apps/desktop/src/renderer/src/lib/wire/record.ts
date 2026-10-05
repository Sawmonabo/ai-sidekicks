// Reads one wire-supplied value as a record with keys, the check every walk of an untyped payload
// makes before indexing. It is separate from `strings.ts` because that module's rules
// (empty string is absent) say nothing about records, and it sits in `lib/` because its callers
// span layers and features that cannot import each other.
//
// It reads no property: the value crossed an untyped boundary, and a hostile getter must not run
// inside the guard. An array is not a record; a null-prototype object is, since a value from a
// structured clone or another realm keeps its keys.

/**
 * One wire-supplied value as a record with readable keys, or not. Narrows to
 * `Readonly<Record<string, unknown>>` so callers can index without a cast; members stay `unknown`.
 */
export function isWireRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
