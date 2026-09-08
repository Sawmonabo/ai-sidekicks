// How a nested answer is ADDRESSED: read one member, write one, drop one, read a list.
//
// SPLIT FROM WHAT A FORM OPENS HOLDING, because the two are different jobs over one value.
// Nothing here reads a plan, a descriptor, or a schema: every function takes a path and an
// object and answers about that object alone, which is why the seed, the write path, the
// hook and the attachment reader can all reach it without any of them reaching each other.
//
// EVERY WRITE REBUILDS AND NONE MUTATES. The answer is the value React re-renders on, so a
// mutation in place is the same object identity and the surface would not repaint — which
// is a rule about this module and not about any of its callers, and is why it is stated
// once here rather than in each of them.

import type { SchemaMemberPath } from "../../bridge/index.js";

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

/** Read one member out of a nested answer without asserting the shape of what is there. */
export function memberAt(answer: SchemaFormAnswer, memberPath: SchemaMemberPath): unknown {
  let cursor: unknown = answer;
  for (const segment of memberPath) {
    const record = asAnswerRecord(cursor);
    if (record === undefined) {
      return undefined;
    }
    cursor = record[String(segment)];
  }
  return cursor;
}

/**
 * Write one member of a nested answer, rebuilding every object on the way down.
 *
 * Rebuilt rather than mutated because the answer is the value React re-renders on: a
 * mutation in place is the same object identity and the surface would not repaint.
 */
export function withMemberAt(
  answer: SchemaFormAnswer,
  memberPath: SchemaMemberPath,
  value: unknown,
): SchemaFormAnswer {
  const [leading, ...rest] = memberPath;
  if (leading === undefined) {
    return answer;
  }
  // An array position is a number on the path and a string key on the object it is written
  // into, so the segment is spelled as the key it addresses.
  const head = String(leading);
  if (rest.length === 0) {
    return { ...answer, [head]: value };
  }
  const childRecord = asAnswerRecord(answer[head]) ?? NOTHING_ANSWERED;
  return { ...answer, [head]: withMemberAt(childRecord, rest, value) };
}

/** Whatever sits at this path, read as a list. Never `undefined`, so a map is safe. */
export function listAt(answer: SchemaFormAnswer, memberPath: SchemaMemberPath): readonly unknown[] {
  const held = memberAt(answer, memberPath);
  return Array.isArray(held) ? (held as readonly unknown[]) : [];
}

/**
 * One record without one of its keys, rebuilt rather than mutated for the header's reason.
 *
 * DELETED AND NOT SET TO `undefined`. A key holding `undefined` is present to every reader
 * that walks the object — `Object.keys`, a spread, and the compiled validator's own
 * `maxProperties` among them — so a member the form means to leave out has to leave.
 */
export function withoutKey(record: SchemaFormAnswer, key: string): SchemaFormAnswer {
  return Object.fromEntries(Object.entries(record).filter(([held]) => held !== key));
}
