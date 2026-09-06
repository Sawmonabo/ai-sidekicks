// Reading one wire-supplied value as a record with keys.
//
// The other half of the pair `core/wire-strings.ts` opens. That module answers what
// counts as a present STRING on a value the store holds wire-verbatim; this one
// answers what counts as a value with readable KEYS, which is the question every
// walk of an untyped payload asks before it indexes anything. Three modules had each
// written the same three clauses for themselves —
// `bridge/run-streams/queue-row-source.ts` as `isWireObject`,
// `frame/run-entity-body.ts` inline in its object reader, and
// `persistence/value-classes.ts` as `isPlainObject` over its own value tree — which
// is one rule with three spellings and no instrument holding them together.
//
// IT IS ITS OWN MODULE RATHER THAN A SECOND EXPORT OF `wire-strings.ts`. That module
// is named for the noun it owns and its header is the string rule end to end: the
// empty string is absent, whitespace is content, and it is not the registered-shape
// read next door. None of those sentences is true of a record, and re-describing the
// module to admit one would leave a reader of either rule holding the other's
// reasoning. Siblings in `core/` for the same reason `readWireString` is here at all:
// the readers are view families, and view families never import each other.
//
// IT LIVES IN `core/` AND NOT IN THE FAMILY THAT NEEDED IT FIRST. Its callers sit in
// `bridge/`, `frame/`, and `persistence/` — three different heights on the console's
// family DAG, two of which cannot reach the third. The floor is the only home a
// shared rule can have, and this one needs nothing at all: no store type, no schema,
// no React.
//
// IT READS NO PROPERTY, and that is a property of the predicate rather than an
// accident of how it is written. Every caller is holding a value that crossed an
// untyped boundary — a scripted reply, an event payload, a persisted blob — so a
// getter here would run whatever a hostile or merely broken accessor does, inside the
// guard that exists to decide whether the value can be read at all. `typeof`,
// `!== null`, and `Array.isArray` all answer without touching a key.
//
// AN ARRAY IS NOT A RECORD, which is the clause a hand-written `typeof x === "object"`
// keeps forgetting. Every caller goes on to enumerate keys or index by name, and an
// array answers both — with its own indices, which is a body composed of a length and
// some numbers. A NULL-PROTOTYPE object IS one: a value that crossed a structured
// clone or arrived from another realm has no prototype chain left and still carries
// exactly the keys its producer put on it, which is the same judgement
// `core/refusal.ts` makes about a refusal that travelled.

/**
 * One wire-supplied value as a record with readable keys, or not.
 *
 * `Readonly<Record<string, unknown>>` rather than `object`, because what every caller
 * does next is index it: a narrowing to `object` would make `value["items"]` an error
 * and leave each caller to cast, which is the judgement being hoisted written out
 * again. The members stay `unknown` — this predicate says the value has keys, never
 * what is behind one.
 */
export function isWireRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
