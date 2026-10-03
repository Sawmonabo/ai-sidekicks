// What an answer is, before anything decides what belongs in one: its type and the empty answer,
// kept apart so the seed and the projection can both reach them without reaching each other.

/** The answer being composed: the object a submission would carry. */
export type SchemaFormAnswerValue = Readonly<Record<string, unknown>>;

/** The answer an untouched form composes before anything has been seeded into it. */
export const NOTHING_ANSWERED: SchemaFormAnswerValue = {};
