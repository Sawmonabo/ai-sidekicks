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
// A CONTROL WITH NO DECLARED VALUE OPENS EMPTY — EXCEPT THE ONE THAT CANNOT. Most of the
// controls have an empty state a person can read as "not answered yet": a blank text box,
// a number box with nothing in it, a select showing its unanswered option. A checkbox has
// no such state. An unchecked box says NO, and it says it before anybody touches it, so a
// form that left the member out of the answer displayed one thing and submitted another —
// and the only way to send `false` was to check the box and uncheck it again. So a member
// DRAWN AS A BOX opens `false` in the answer, and `schema-fields.ts` owns which members
// those are: the ones the answer must hold a value for. A boolean it may leave out is
// drawn through the choice control instead, so its absence is a state on the screen rather
// than a state the form cannot reach — which is not a seventh kind, the render set
// `Spec-017 §Default Behavior` fixes being about what a schema may ASK for.
//
// A GROUP'S OWN `default` IS SEEDED THROUGH ITS CHILDREN AND NEVER AS AN OBJECT. A group
// is a container: no control displays its object, so writing that object whole would put
// a member into the submission nothing on the screen accounts for. But dropping it is the
// same divergence from the other side — the compiled reader supplies a declared object to
// its own accepted value, so a form that ignored one displayed blank controls while the
// value it was told was valid carried the author's. So the seed takes the NEAREST declared
// value on a member's path: the control's own where it has one, else the enclosing group's
// projected at that member's key. A group default a child could not show never reaches
// here at all — the mapper sends that schema to the raw editor.
//
// AND A DRAWN COLLECTION OPENS AS THE EMPTY LIST IT IS ALREADY SHOWING. A list with no
// declared entries renders its heading, its add control, and no entries, which IS an
// answer — so the member is `[]` rather than absent. Left out, a required array that
// legally accepts zero entries opened invalid and could not be submitted until somebody
// added an entry and removed it again.

import {
  fieldDrawsAsCheckbox,
  leafKeyOf,
  type SchemaFieldDescriptor,
  type SchemaFieldKind,
  type SchemaFormPlan,
  type SchemaLeafEntry,
} from "./schema-fields.js";
import { isSameMemberPath, type SchemaMemberPath } from "../../bridge/index.js";

/** The answer being composed: the object a submission would carry. */
export type SchemaFormAnswer = Readonly<Record<string, unknown>>;

/** The answer an untouched form composes before anything has been seeded into it. */
const NOTHING_ANSWERED: SchemaFormAnswer = {};

/** What a collection nobody has added to holds. Never written to; only ever replaced. */
const NO_ENTRIES_YET: readonly unknown[] = [];

/** The empty answer the two text controls display and write when a person clears one. */
const EMPTY_TEXT = "";

/**
 * What one control of a kind holds while nobody has answered it, as a value.
 *
 * ONE TABLE, AND THE TWO PLACES AN OPENING VALUE IS DECIDED BOTH READ IT. It is the value
 * that control's own `onChange` writes for its empty display — `""` from the two text
 * boxes, `false` from a box that cannot be blank, and NOTHING at all from the three whose
 * empty state is the member being absent: a number box shows nothing for a string, and a
 * select's unanswered option is deliberately worth no member value, so `""` at either is a
 * payload holding what no control on the screen is displaying.
 */
function untouchedControlValue(kind: SchemaFieldKind): unknown {
  switch (kind) {
    case "text":
    case "long-text":
      return EMPTY_TEXT;
    case "checkbox":
      return false;
    case "number":
    case "choice":
    case "artifact-reference":
      return undefined;
  }
}

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
 * What one STANDALONE member opens holding, or `undefined` where it opens with nothing.
 *
 * `undefined` is unambiguous as "seed nothing": JSON carries no such value, so a schema
 * cannot declare one and a caller cannot mistake a declared value for an absent one.
 *
 * A member nobody has answered is ABSENT wherever the control can display that, which is
 * why this asks the one rule about which control a member draws through. Every control
 * with an empty state a person reads as unanswered opens absent, and absence is how this
 * answer spells it — so a schema saying "at least three characters" about an optional text
 * member reports nothing until somebody types, rather than opening with a complaint about
 * a control they never touched. A BOX has no such state, so a member drawn as one opens at
 * the value its own display already asserts; a boolean the answer may leave out is not
 * drawn as one, and opens absent like everything else that can be.
 */
function openingMemberValue(field: SchemaFieldDescriptor, declaredValue: unknown): unknown {
  if (declaredValue !== undefined) {
    return declaredValue;
  }
  return fieldDrawsAsCheckbox(field) ? untouchedControlValue(field.kind) : undefined;
}

/**
 * What one ENTRY of a list opens holding, which is never nothing.
 *
 * The position exists the moment somebody presses the add control, so absence is not
 * available to it the way it is to a standalone member: the entry is on the screen either
 * way. What it holds is therefore what its control shows for an untouched one — and the
 * three whose untouched value is `undefined` are unanswered IN the drawn list, which is
 * what the validator reads them as and what the control renders.
 */
function openingEntryValue(item: SchemaFieldDescriptor, declaredValue: unknown): unknown {
  return declaredValue !== undefined ? declaredValue : untouchedControlValue(item.kind);
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

/**
 * The NEAREST value declared for one leaf: its control's own, else its group's for it.
 *
 * Nearest and not merged, because the two are answers to the same question and a control
 * that declares one has said what it opens at. A group one level up is the only other
 * place a value for this member can be written — `SchemaGroupDescriptor` holds leaves and
 * never another group, so there is no third level for a walk to reach.
 */
function nearestDeclaredValue(
  leaf: SchemaLeafEntry,
  groupDefault: SchemaFormAnswer | undefined,
): unknown {
  const ownValue = leaf.form === "list" ? leaf.list.defaultValue : leaf.field.defaultValue;
  if (ownValue !== undefined || groupDefault === undefined) {
    return ownValue;
  }
  const key = leafKeyOf(leaf);
  return key === undefined ? undefined : groupDefault[key];
}

/** Where one leaf's value sits in the answer, and what it opens holding. */
function openingValueOf(
  leaf: SchemaLeafEntry,
  groupDefault: SchemaFormAnswer | undefined,
): {
  readonly memberPath: SchemaMemberPath;
  readonly value: unknown;
} {
  const declaredValue = nearestDeclaredValue(leaf, groupDefault);
  return leaf.form === "list"
    ? {
        memberPath: leaf.list.memberPath,
        // The drawn collection is the answer's, so an undeclared one opens at the empty
        // list its control is already rendering rather than at no member at all.
        value: declaredEntries(declaredValue) ?? NO_ENTRIES_YET,
      }
    : {
        memberPath: leaf.field.memberPath,
        value: openingMemberValue(leaf.field, declaredValue),
      };
}

/**
 * The answer a drawn form opens with: every control's own declared value, and nothing else.
 *
 * Read ONCE, at the mount. A seed recomputed when the schema's identity changed would
 * discard what somebody had typed every time a run read refreshed and handed down an
 * equal schema as a new object.
 *
 * Walked as entries rather than as flattened leaves, because a group's declared value has
 * to travel with the leaves it names: flattened, the only thing left of the group is the
 * path segment its children carry, and the value would have nowhere to be read from.
 */
export function seedAnswerFromPlan(plan: SchemaFormPlan): SchemaFormAnswer {
  if (plan.shape !== "fields") {
    return NOTHING_ANSWERED;
  }
  let seeded: SchemaFormAnswer = NOTHING_ANSWERED;
  for (const entry of plan.entries) {
    const isGroup = entry.form === "group";
    const groupDefault = isGroup ? asAnswerRecord(entry.group.defaultValue) : undefined;
    for (const leaf of isGroup ? entry.group.entries : [entry]) {
      const opening = openingValueOf(leaf, groupDefault);
      if (opening.value !== undefined) {
        seeded = withMemberAt(seeded, opening.memberPath, opening.value);
      }
    }
  }
  return seeded;
}

/**
 * What an entry added to this list opens holding.
 *
 * The item schema's own declared value where it has one, and otherwise what that control
 * shows for an untouched entry — read from the one table above, so a repeated control and
 * a standalone one of the same kind never open at two different values.
 *
 * A path the plan drew no list for is a caller asking about a collection this form does
 * not have. There is no control there to derive an opening value from, so there is no
 * value: inventing one would put a member of some kind into a list of another.
 */
export function newListEntryFor(plan: SchemaFormPlan, memberPath: SchemaMemberPath): unknown {
  for (const leaf of drawnLeaves(plan)) {
    if (leaf.form === "list" && isSameMemberPath(leaf.list.memberPath, memberPath)) {
      return openingEntryValue(leaf.list.item, leaf.list.item.defaultValue);
    }
  }
  return undefined;
}
