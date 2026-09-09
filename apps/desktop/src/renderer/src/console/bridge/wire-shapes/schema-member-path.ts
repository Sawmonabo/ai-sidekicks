// How one member of an answer is ADDRESSED: the representation every surface and every
// finding shares, and the single string spelling it takes where a string is what the
// platform wants.
//
// IT IS A SIBLING OF THE VALIDATOR RATHER THAN PART OF IT, AND THE SPLIT IS THE POINT.
// `json-schema-check.ts` next door compiles a delivered schema, which means it imports a
// schema library and is reached through a loader so that library stays off the console's
// initial import graph. Addressing needs none of that: it is six lines of string and array
// work that the schema form's descriptors, its controls, its draft writes and its plan all
// read on their first render. Left in the validator's module they would have held that
// library's whole sub-graph on the door — a value the door publishes is charged to every
// launch — so what the door publishes eagerly is this, and the compiler arrives when a
// form is actually drawn.
//
// THE ISSUE PATH TRAVELS AS SEGMENTS, BECAUSE A JOINED PATH IS NOT INJECTIVE. The schema
// library reports a path of property keys and array indices, and joining those with a dot
// collapses members a schema keeps apart: a property literally named `items.0` and the
// first entry of an array named `items` both spell `items.0`, and so do a property named
// `a.b` and a `b` nested inside an `a`. A surface keyed on that string draws one member's
// verdict under another member's control — or under both — which is a finding rendered
// about a value the schema said nothing about. So the segments travel whole, the lookup
// that matches a control to its findings compares them element by element through
// `isSameMemberPath`, and the one place a path has to become a string — a React key, an
// element id, a sentence naming the member — takes the RFC 6901 JSON Pointer that
// `encodeMemberPointer` composes, which escapes rather than collapses. One representation,
// one encoder, and no surface re-derives either.

/**
 * Where one member sits inside an answer: property keys and array positions, in order.
 *
 * `number` is not decoration. The reader reports an array position AS a number, and that
 * is the only thing keeping it apart from a property whose name happens to be a digit —
 * a distinction any single-string spelling of the path throws away.
 */
export type SchemaMemberPath = readonly (string | number)[];

/**
 * One segment as an RFC 6901 reference token.
 *
 * The escape character is replaced FIRST. Doing the separator first would then escape the
 * `~` this step just wrote, turning `a/b` into `a~01b` — a token that decodes to something
 * nobody wrote.
 */
function referenceTokenOf(segment: string | number): string {
  return String(segment).replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * One member path as the RFC 6901 JSON Pointer that names it — the string spelling, where
 * a string is what the platform takes.
 *
 * Reversible where a join is not: `/` and `~` are the two characters that grammar gives
 * meaning to, so a segment carrying either is escaped rather than left to read as a
 * boundary. The empty path encodes as the empty string, which is that grammar's own name
 * for the whole document and is what an issue about the answer itself carries.
 */
export function encodeMemberPointer(path: SchemaMemberPath): string {
  return path.map((segment) => `/${referenceTokenOf(segment)}`).join("");
}

/**
 * Whether two member paths address the same member.
 *
 * Element by element and by identity, so a property named `"0"` and the array position `0`
 * stay apart. This is the comparison every lookup makes, and it is here rather than beside
 * one of them because a second comparison is how two readings of one path come apart.
 */
export function isSameMemberPath(left: SchemaMemberPath, right: SchemaMemberPath): boolean {
  return left.length === right.length && left.every((segment, at) => segment === right[at]);
}
