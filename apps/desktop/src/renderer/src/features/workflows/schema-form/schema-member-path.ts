// How one member of an answer is addressed: the representation every control and finding shares.
// Kept apart from the validator so the descriptors, controls, draft writes and plan can import it
// statically without waiting on the schema library's chunk. A path travels as segments because a
// dot-joined path is not injective (`items.0` the property and the first entry of `items` collide),
// which would draw one member's finding under another's control. Where a string is needed (a React
// key, an element id) `encodeMemberPointer` composes an escaping RFC 6901 JSON Pointer.

/**
 * Where one member sits inside an answer: property keys and array positions, in order. A position
 * stays a `number` to keep it apart from a property whose name is a digit.
 */
export type SchemaMemberPath = readonly (string | number)[];

/**
 * One member path as the RFC 6901 JSON Pointer that names it. `/` and `~` are escaped, so it is
 * reversible where a join is not; the empty path encodes as `""`, the pointer for the whole answer.
 */
export function encodeMemberPointer(path: SchemaMemberPath): string {
  return path.map((segment) => `/${referenceTokenOf(segment)}`).join("");
}

/**
 * Whether two member paths address the same member: element by element and by identity, so a
 * property named `"0"` and the array position `0` stay apart. Every lookup uses this comparison.
 */
export function isSameMemberPath(left: SchemaMemberPath, right: SchemaMemberPath): boolean {
  return left.length === right.length && left.every((segment, at) => segment === right[at]);
}

/** One segment as an RFC 6901 token; `~` is escaped first so the `~` written for `/` survives. */
function referenceTokenOf(segment: string | number): string {
  return String(segment).replace(/~/g, "~0").replace(/\//g, "~1");
}
