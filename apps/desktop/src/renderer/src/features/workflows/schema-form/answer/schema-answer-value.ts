// What an answer is, before anything decides what belongs in one. Every function takes a value and
// answers about that value alone, so the seed and the projection can both reach it without
// reaching each other.

/** The answer being composed: the object a submission would carry. */
export type SchemaFormAnswerValue = Readonly<Record<string, unknown>>;

/** The answer an untouched form composes before anything has been seeded into it. */
export const NOTHING_ANSWERED: SchemaFormAnswerValue = {};

/**
 * Whatever this is, read as a set of named values, or nothing where it is not one. An array is
 * not: it holds positions, so walking into it by key would answer for a member that cannot exist.
 */
export function asAnswerRecord(value: unknown): SchemaFormAnswerValue | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as SchemaFormAnswerValue)
    : undefined;
}
