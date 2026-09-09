// What an answer IS, before anything has decided what belongs in one.
//
// The type a submission carries, the value an untouched form composes, and the one
// reading that says whether a value can be walked by name at all. Nothing here reads a
// plan, a descriptor, or a schema: every function takes a value and answers about that
// value alone, which is why the seed and the projection can both reach it without either
// of them reaching the other.
//
// IT ONCE HELD THE PATH WALK TOO — read one member, write one, drop one, read a list —
// and that half was never called by anything. The kit addresses its answer through the
// PLAN it drew rather than by walking a path into the answer, so the walk was a second
// way to reach a value the projection already reaches, and it went. The three names left
// are the ones the kit reads.

/** The answer being composed: the object a submission would carry. */
export type SchemaFormAnswer = Readonly<Record<string, unknown>>;

/** The answer an untouched form composes before anything has been seeded into it. */
export const NOTHING_ANSWERED: SchemaFormAnswer = {};

/**
 * Whatever this is, read as a set of named values — or nothing where it is not one.
 *
 * One reading, used by the places that need it. An array is deliberately not one: it
 * holds positions rather than names, so walking into it by key would answer for a member
 * that cannot exist.
 */
export function asAnswerRecord(value: unknown): SchemaFormAnswer | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as SchemaFormAnswer)
    : undefined;
}
