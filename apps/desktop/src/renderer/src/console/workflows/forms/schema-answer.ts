// What a drawn form OPENS holding, and what one control's change does to the answer.
//
// How the answer object itself is addressed — read a member, write one, drop one, read a
// list — is `schema-answer-paths.ts`, which knows nothing about a plan. This module is the
// half that reads the plan the mapper drew.
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
// WHAT AN UNANSWERED MEMBER IS WORTH IS ONE RULE, AND IT LIVES IN `schema-fields.ts`.
// Nothing here re-decides whether a control opens present: this module asks
// `unansweredFieldValue` / `unansweredListValue` / `unansweredGroupValue` and writes what
// they answer, exactly as every control's change handler does when a person clears one. So
// the value a form opens at and the value it returns to are the same value by
// construction, rather than by two readings that agree today.
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
// AND AN ABSENT MEMBER IS REMOVED RATHER THAN WRITTEN AS `undefined`. A key holding
// `undefined` is present to every reader that walks the object — the compiled validator's
// `maxProperties` among them — so this module's one write path DELETES the key instead,
// and prunes the enclosing group where that emptied one the schema does not require.

import {
  emptyControlValue,
  leafKeyOf,
  memberKeyOf,
  unansweredFieldValue,
  unansweredGroupValue,
  unansweredListValue,
  type SchemaFieldDescriptor,
  type SchemaFormPlan,
  type SchemaGroupDescriptor,
  type SchemaLeafEntry,
  type SchemaListDescriptor,
} from "./schema-fields.js";
import {
  asAnswerRecord,
  listAt,
  NOTHING_ANSWERED,
  withMemberAt,
  withoutKey,
  type SchemaFormAnswer,
} from "./schema-answer-paths.js";
import { isSameMemberPath, type SchemaMemberPath } from "../../bridge/index.js";

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
 * The declared value where the schema wrote one, and otherwise the ONE rule's answer for
 * an unanswered member of this kind — the same call the control makes when a person clears
 * it, which is what makes opening and returning to unanswered one state rather than two.
 */
function openingMemberValue(field: SchemaFieldDescriptor, declaredValue: unknown): unknown {
  return declaredValue !== undefined ? declaredValue : unansweredFieldValue(field);
}

/**
 * What one ENTRY of a list opens holding, which is never nothing.
 *
 * The position exists the moment somebody presses the add control, so absence is not
 * available to it the way it is to a standalone member: the entry is on the screen either
 * way. What it holds is therefore what its control DISPLAYS for an untouched one, read
 * from the shared table in `schema-fields.ts` — and the three whose empty display is worth
 * nothing are unanswered IN the drawn list, which is what the validator reads them as and
 * what the control renders.
 */
function openingEntryValue(item: SchemaFieldDescriptor, declaredValue: unknown): unknown {
  return declaredValue !== undefined ? declaredValue : emptyControlValue(item.kind);
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
        // The declared entries where the schema wrote a list of them, and otherwise the
        // one rule's answer: `[]` where the collection must exist, and nothing at all
        // where the answer may leave it out until somebody adds an entry.
        value: declaredEntries(declaredValue) ?? unansweredListValue(leaf.list),
      }
    : {
        memberPath: leaf.field.memberPath,
        value: openingMemberValue(leaf.field, declaredValue),
      };
}

/** One leaf's opening value written into the answer, or the answer untouched where it has none. */
function withSeededLeaf(
  seeded: SchemaFormAnswer,
  leaf: SchemaLeafEntry,
  groupDefault: SchemaFormAnswer | undefined,
): SchemaFormAnswer {
  const opening = openingValueOf(leaf, groupDefault);
  return opening.value === undefined
    ? seeded
    : withMemberAt(seeded, opening.memberPath, opening.value);
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
 *
 * A GROUP IS SEEDED BEFORE ITS LEAVES ARE FOLDED IN, which is what puts a required one in
 * the answer even when none of its members contributes a value. Left to the leaves, a
 * schema requiring an object whose every member is optional opened on an answer that did
 * not hold the object, offered no control that could create it, and stayed invalid whatever
 * anybody typed. An optional group is seeded with nothing and appears the moment a member
 * of it is answered, which is the same rule read the other way.
 */
export function seedAnswerFromPlan(plan: SchemaFormPlan): SchemaFormAnswer {
  if (plan.shape !== "fields") {
    return NOTHING_ANSWERED;
  }
  let seeded: SchemaFormAnswer = NOTHING_ANSWERED;
  for (const entry of plan.entries) {
    if (entry.form !== "group") {
      seeded = withSeededLeaf(seeded, entry, undefined);
      continue;
    }
    const openingGroup = unansweredGroupValue(entry.group);
    if (openingGroup !== undefined) {
      seeded = withMemberAt(seeded, entry.group.memberPath, openingGroup);
    }
    const groupDefault = asAnswerRecord(entry.group.defaultValue);
    for (const leaf of entry.group.entries) {
      seeded = withSeededLeaf(seeded, leaf, groupDefault);
    }
  }
  return seeded;
}

/**
 * What an entry added to this list opens holding.
 *
 * The item schema's own declared value where it has one, and otherwise what that control
 * shows for an untouched entry — read from the shared table, so a repeated control and a
 * standalone one of the same kind never open at two different values.
 *
 * A path the plan drew no list for is a caller asking about a collection this form does
 * not have. There is no control there to derive an opening value from, so there is no
 * value: inventing one would put a member of some kind into a list of another.
 */
export function newListEntryFor(plan: SchemaFormPlan, memberPath: SchemaMemberPath): unknown {
  const list = listDrawnAt(plan, memberPath);
  return list === undefined ? undefined : openingEntryValue(list.item, list.item.defaultValue);
}

/** The collection the plan drew at one path, or nothing where it drew none there. */
function listDrawnAt(
  plan: SchemaFormPlan,
  memberPath: SchemaMemberPath,
): SchemaListDescriptor | undefined {
  for (const leaf of drawnLeaves(plan)) {
    if (leaf.form === "list" && isSameMemberPath(leaf.list.memberPath, memberPath)) {
      return leaf.list;
    }
  }
  return undefined;
}

/** The group the plan drew under one root key, or nothing where that key names no group. */
function groupDrawnUnder(
  plan: SchemaFormPlan,
  groupKey: string,
): SchemaGroupDescriptor | undefined {
  if (plan.shape !== "fields") {
    return undefined;
  }
  for (const entry of plan.entries) {
    if (entry.form === "group" && memberKeyOf(entry.group.memberPath) === groupKey) {
      return entry.group;
    }
  }
  return undefined;
}

/**
 * Write what one control composed — and where that is ABSENCE, take the member out.
 *
 * THE ONE WRITE PATH FOR A DRAWN CONTROL, and the reason it takes the plan. A control
 * reports what its display is worth (`schema-fields.ts`'s rule), and this is where that
 * answer becomes the shape of the object: a value is written at the path, and absence
 * REMOVES the key rather than parking `undefined` in it, because a key holding `undefined`
 * is present to every reader that walks the object and the compiled validator's own
 * `maxProperties` is one of them.
 *
 * AND THE GROUP THAT REMOVAL EMPTIED FOLLOWS THE SAME RULE. A group is a member too, so an
 * optional one whose last answered member has just left goes with it, while a required one
 * stays as the `{}` its legend stands over. Asked of the plan rather than derived from the
 * answer, because "was this group required" is a reading of the schema and the answer does
 * not carry one. One level and no walk: `SchemaGroupDescriptor` holds leaves and never
 * another group, so a path is one segment or two and there is no third depth to prune.
 */
export function withMemberAnswered(
  plan: SchemaFormPlan,
  answer: SchemaFormAnswer,
  memberPath: SchemaMemberPath,
  value: unknown,
): SchemaFormAnswer {
  if (value !== undefined) {
    return withMemberAt(answer, memberPath, value);
  }
  const [leading, ...rest] = memberPath;
  if (leading === undefined) {
    return answer;
  }
  const head = String(leading);
  if (rest.length === 0) {
    return withoutKey(answer, head);
  }
  const groupRecord = asAnswerRecord(answer[head]);
  if (groupRecord === undefined) {
    return answer;
  }
  const pruned = withoutKey(groupRecord, String(rest[0]));
  const group = groupDrawnUnder(plan, head);
  const groupSurvivesEmpty =
    Object.keys(pruned).length > 0 ||
    (group !== undefined && unansweredGroupValue(group) !== undefined);
  return groupSurvivesEmpty ? { ...answer, [head]: pruned } : withoutKey(answer, head);
}

/**
 * One entry dropped from a collection, with the collection itself following the same rule.
 *
 * The entries are positions, so the array is rebuilt rather than holed — and when the last
 * of them leaves, what stays is what an unanswered collection is worth: `[]` where the
 * schema requires it, and nothing at all where it does not. Without that second half a
 * presence-sensitive schema had no way back: adding an entry and removing it left `[]`
 * behind, and no control on the form could take it away again.
 */
export function withListEntryRemoved(
  plan: SchemaFormPlan,
  answer: SchemaFormAnswer,
  memberPath: SchemaMemberPath,
  index: number,
): SchemaFormAnswer {
  const remaining = listAt(answer, memberPath).filter((_entry, at) => at !== index);
  const list = listDrawnAt(plan, memberPath);
  const written =
    remaining.length === 0 && list !== undefined ? unansweredListValue(list) : remaining;
  return withMemberAnswered(plan, answer, memberPath, written);
}
