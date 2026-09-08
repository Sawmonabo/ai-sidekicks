// The answer a drawn form composes, as a value: how a member is read and written, and
// what every control opens holding.
//
// SPLIT FROM THE HOOK BECAUSE THESE ARE PURE AND THE HOOK IS NOT. Nothing here reads
// React, holds state, or knows a form is mounted — which is what lets the opening values
// be settled by walking the plan the mapper drew rather than by asking the compiled
// validator what it makes of an empty object.
//
// THE SEED IS PER CONTROL, AND THAT IS THE WHOLE POINT. Asking the validator to read `{}`
// answers all or nothing: a schema requiring one member it declares no value for makes
// that reading a REFUSAL, and a refusal carries no accepted value — so every default the
// schema did declare was thrown away with it, the controls opened blank, and the values
// came back into the submission the moment the unrelated member was answered. Walking the
// descriptors has no such coupling: each control opens at its own declared value, whatever
// the schema thinks of the answer as a whole, and what a person is looking at is what a
// press would send.
//
// A CONTROL WITH NO DECLARED VALUE OPENS EMPTY — EXCEPT THE ONE THAT CANNOT. Five of the
// six controls have an empty state a person can read as "not answered yet": a blank text
// box, a number box with nothing in it, a select showing its unanswered option. A checkbox
// has no such state. An unchecked box says NO, and it says it before anybody touches it,
// so a form that left the member out of the answer displayed one thing and submitted
// another — and the only way to send `false` was to check the box and uncheck it again.
// So a boolean control opens `false` in the answer, required or not, and the render set
// `Spec-017 §Default Behavior` fixes is what makes that the only honest reading: a
// tri-state box would be a seventh kind of control, and there are six.
//
// AND A GROUP'S OWN `default` IS NOT SEEDED. A group is a container: no control displays
// its object, so a value written there is a member of the submission that nothing on the
// screen can account for — the very divergence this module exists to close. Its children's
// declared values ARE seeded, each through the control that shows it, which creates the
// group as a side effect of filling in something visible rather than as a value of its own.

import type { SchemaFieldDescriptor, SchemaFormPlan, SchemaLeafEntry } from "./schema-fields.js";

/** The answer being composed: the object a submission would carry. */
export type SchemaFormAnswer = Readonly<Record<string, unknown>>;

/** The answer an untouched form composes before anything has been seeded into it. */
const NOTHING_ANSWERED: SchemaFormAnswer = {};

/** What one entry of a list opens holding where its own schema declares nothing. */
const EMPTY_LIST_ENTRY = "";

/**
 * Whatever this is, read as a set of named values — or nothing where it is not one.
 *
 * One reading, used by the places that need it. An array is deliberately not one: it
 * holds positions rather than names, so walking into it by key would answer for a member
 * that cannot exist.
 */
function asAnswerRecord(value: unknown): SchemaFormAnswer | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as SchemaFormAnswer)
    : undefined;
}

/** Read one member out of a nested answer without asserting the shape of what is there. */
export function memberAt(answer: SchemaFormAnswer, memberPath: readonly string[]): unknown {
  let cursor: unknown = answer;
  for (const segment of memberPath) {
    const record = asAnswerRecord(cursor);
    if (record === undefined) {
      return undefined;
    }
    cursor = record[segment];
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
  memberPath: readonly string[],
  value: unknown,
): SchemaFormAnswer {
  const [head, ...rest] = memberPath;
  if (head === undefined) {
    return answer;
  }
  if (rest.length === 0) {
    return { ...answer, [head]: value };
  }
  const childRecord = asAnswerRecord(answer[head]) ?? NOTHING_ANSWERED;
  return { ...answer, [head]: withMemberAt(childRecord, rest, value) };
}

/** Whatever sits at this path, read as a list. Never `undefined`, so a map is safe. */
export function listAt(
  answer: SchemaFormAnswer,
  memberPath: readonly string[],
): readonly unknown[] {
  const held = memberAt(answer, memberPath);
  return Array.isArray(held) ? (held as readonly unknown[]) : [];
}

/**
 * Every control the plan drew, in the order it drew them, with groups walked through.
 *
 * Flat because a group is one level deep by construction — `SchemaGroupDescriptor` holds
 * leaves and never another group — so a recursive walk here would be machinery for a
 * shape the type forbids.
 */
function drawnLeaves(plan: SchemaFormPlan): readonly SchemaLeafEntry[] {
  return plan.shape === "fields"
    ? plan.entries.flatMap((entry) => (entry.form === "group" ? entry.group.entries : [entry]))
    : [];
}

/**
 * What one control opens holding, or `undefined` where it opens with nothing at all.
 *
 * `undefined` is unambiguous as "seed nothing": JSON carries no such value, so a schema
 * cannot declare one and a caller cannot mistake a declared value for an absent one.
 */
function openingFieldValue(field: SchemaFieldDescriptor): unknown {
  if (field.defaultValue !== undefined) {
    return field.defaultValue;
  }
  return field.kind === "checkbox" ? false : undefined;
}

/**
 * A collection's declared `default`, taken only where it declared a list.
 *
 * Narrowed HERE, before the value is written, rather than trusted from the descriptor: a
 * `default` of another shape is one the compiled validator refuses on its own terms, and
 * seeding it would put a string at a member whose control renders lists — the answer
 * holding one thing while the surface showed another, which is what this module exists
 * to prevent.
 */
function declaredEntries(declared: unknown): readonly unknown[] | undefined {
  return Array.isArray(declared) ? (declared as readonly unknown[]) : undefined;
}

/** Where one leaf's value sits in the answer, and what it opens holding. */
function openingValueOf(leaf: SchemaLeafEntry): {
  readonly memberPath: readonly string[];
  readonly value: unknown;
} {
  return leaf.form === "list"
    ? { memberPath: leaf.list.memberPath, value: declaredEntries(leaf.list.defaultValue) }
    : { memberPath: leaf.field.memberPath, value: openingFieldValue(leaf.field) };
}

/**
 * The answer a drawn form opens with: every control's own declared value, and nothing else.
 *
 * Read ONCE, at the mount. A seed recomputed when the schema's identity changed would
 * discard what somebody had typed every time a run read refreshed and handed down an
 * equal schema as a new object.
 */
export function seedAnswerFromPlan(plan: SchemaFormPlan): SchemaFormAnswer {
  let seeded: SchemaFormAnswer = NOTHING_ANSWERED;
  for (const leaf of drawnLeaves(plan)) {
    const opening = openingValueOf(leaf);
    if (opening.value !== undefined) {
      seeded = withMemberAt(seeded, opening.memberPath, opening.value);
    }
  }
  return seeded;
}

/** Whether two member paths address the same member, compared segment by segment. */
function isSameMemberPath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, at) => segment === right[at]);
}

/**
 * What an entry added to this list opens holding.
 *
 * The same rule one control opens under, applied to the control a new entry draws: the
 * item schema's own declared value where it has one, `false` for a box that would
 * otherwise render unchecked while the answer held a string, and the empty text every
 * other control reads as unanswered. A path the plan drew no list for is a caller asking
 * about a collection this form does not have, and takes the empty entry.
 */
export function newListEntryFor(plan: SchemaFormPlan, memberPath: readonly string[]): unknown {
  for (const leaf of drawnLeaves(plan)) {
    if (leaf.form === "list" && isSameMemberPath(leaf.list.memberPath, memberPath)) {
      const opening = openingFieldValue(leaf.list.item);
      return opening === undefined ? EMPTY_LIST_ENTRY : opening;
    }
  }
  return EMPTY_LIST_ENTRY;
}
