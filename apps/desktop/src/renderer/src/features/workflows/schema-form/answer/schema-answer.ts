// What a drawn form opens holding. The seed builds a draft (`schema-draft.ts`) with a node for
// every control on screen and nothing else, and the answer is its projection
// (`schema-projection.ts`), so the value the validator checks and the value a submission sends
// are the same bytes. Pure: no React, no state.
//
// The seed is per control, never read off the validator on `{}`: a schema requiring a member it
// declares no value for would refuse that reading and discard every declared default. An
// optional container opens inactive unless the schema declared a value for it, or an optional
// group holding a required boolean could never satisfy a schema requiring it absent. A group's
// own `default` is seeded through its children, the nearest declared value on a member's path
// winning; one a child could not show sends the schema to the raw editor.

import {
  activeGroup,
  answeredScalar,
  INACTIVE_GROUP,
  INACTIVE_LIST,
  listDraftOf,
  NOTHING_DRAFTED,
  UNANSWERED_SCALAR,
  withGroupMember,
  withNodeAt,
  type SchemaFormDraft,
  type SchemaGroupMembersDraft,
  type SchemaLeafDraft,
  type SchemaListDraft,
  type SchemaScalarDraft,
} from "./schema-draft.js";
import {
  containerOpensAnswered,
  emptyControlValue,
  leafKeyOf,
  leafPathOf,
  memberKeyOf,
  type SchemaFieldDescriptor,
  type SchemaFormPlan,
  type SchemaGroupDescriptor,
  type SchemaLeafEntry,
  type SchemaListDescriptor,
} from "../plan/schema-fields.js";
import { type SchemaFormAnswerValue } from "./schema-answer-value.js";
import { asRecord } from "../plan/schema-declarations.js";
import { isSameMemberPath, type SchemaMemberPath } from "../schema-member-path.js";

/** The leaf the plan drew at one path, or nothing where it drew none there. */
export function leafDrawnAt(
  plan: SchemaFormPlan,
  memberPath: SchemaMemberPath,
): SchemaLeafEntry | undefined {
  for (const leaf of drawnLeaves(plan)) {
    if (isSameMemberPath(leafPathOf(leaf), memberPath)) {
      return leaf;
    }
  }
  return undefined;
}

/** The collection the plan drew at one path, or nothing where it drew a control there. */
export function listDrawnAt(
  plan: SchemaFormPlan,
  memberPath: SchemaMemberPath,
): SchemaListDescriptor | undefined {
  const leaf = leafDrawnAt(plan, memberPath);
  return leaf?.form === "list" ? leaf.list : undefined;
}

/** The group the plan drew under one root key, or nothing where that key names no group. */
export function groupDrawnUnder(
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
 * A collection's node once somebody is answering it, holding whatever the schema declared.
 * Exported for the write path, which needs it when a legend control answers a collection and when
 * a list act lands on a collection the draft holds no node for.
 */
export function answeredListDraft(list: SchemaListDescriptor): SchemaListDraft {
  return openingListEntries(list.defaultValue);
}

/** Every member of one group, opened at whatever that group and its controls declared. */
export function seededGroupMembers(group: SchemaGroupDescriptor): SchemaGroupMembersDraft {
  const groupDefault = asRecord(group.defaultValue);
  let members: SchemaGroupMembersDraft = {};
  for (const leaf of group.entries) {
    const key = leafKeyOf(leaf);
    if (key !== undefined) {
      members = withGroupMember(members, key, openingLeafDraft(leaf, groupDefault));
    }
  }
  return members;
}

/**
 * The draft a drawn form opens with: every control's own declared value, and nothing else. Read
 * once at the mount, because reseeding on a new schema identity would discard what somebody typed
 * whenever a run read refreshed. Walked as entries so a group's declared value travels with the
 * leaves it names.
 */
export function seedDraftFromPlan(plan: SchemaFormPlan): SchemaFormDraft {
  if (plan.shape !== "fields") {
    return NOTHING_DRAFTED;
  }
  let seeded: SchemaFormDraft = NOTHING_DRAFTED;
  for (const entry of plan.entries) {
    if (entry.form === "group") {
      const key = memberKeyOf(entry.group.memberPath);
      if (key !== undefined) {
        seeded = withNodeAt(seeded, key, openingGroupDraft(entry.group));
      }
      continue;
    }
    const key = leafKeyOf(entry);
    if (key !== undefined) {
      seeded = withNodeAt(seeded, key, openingLeafDraft(entry, undefined));
    }
  }
  return seeded;
}

/**
 * What an entry added to this collection opens holding: the item schema's declared value, else
 * what an untouched control of that kind displays (the table in `schema-fields.ts`). The three
 * kinds with no displayed empty value open unanswered, because `undefined` in the array would
 * serialize as `null`. A path with no drawn collection has no control to derive a node from, so
 * there is no node.
 */
export function newListEntryDraft(
  plan: SchemaFormPlan,
  memberPath: SchemaMemberPath,
): SchemaScalarDraft | undefined {
  const list = listDrawnAt(plan, memberPath);
  if (list === undefined) {
    return undefined;
  }
  return openingEntryDraft(list.item);
}

/**
 * Every control the plan drew, in order, groups walked through. Flat because a group is one level
 * deep by construction.
 */
function drawnLeaves(plan: SchemaFormPlan): readonly SchemaLeafEntry[] {
  return plan.shape === "fields"
    ? plan.entries.flatMap((entry) => (entry.form === "group" ? entry.group.entries : [entry]))
    : [];
}

/**
 * A collection's declared `default`, taken only where it declared a list. A default of another
 * shape is refused by the validator, and seeding it would leave the answer holding a string at a
 * member whose control renders lists.
 */
function declaredEntries(declared: unknown): readonly unknown[] | undefined {
  return Array.isArray(declared) ? (declared as readonly unknown[]) : undefined;
}

/**
 * The nearest value declared for one leaf: its control's own, else its group's for it. Not merged:
 * a control that declares one has said what it opens at, and a group is the only other place a
 * value for this member can be written.
 */
function nearestDeclaredValue(
  leaf: SchemaLeafEntry,
  groupDefault: SchemaFormAnswerValue | undefined,
): unknown {
  const ownValue = leaf.form === "list" ? leaf.list.defaultValue : leaf.field.defaultValue;
  if (ownValue !== undefined || groupDefault === undefined) {
    return ownValue;
  }
  const key = leafKeyOf(leaf);
  return key === undefined ? undefined : groupDefault[key];
}

function openingListEntries(declaredValue: unknown): SchemaListDraft {
  return listDraftOf((declaredEntries(declaredValue) ?? []).map(answeredScalar));
}

/** One leaf's opening node: its declared value where the schema wrote one, else nothing. */
function openingLeafDraft(
  leaf: SchemaLeafEntry,
  groupDefault: SchemaFormAnswerValue | undefined,
): SchemaLeafDraft {
  const declaredValue = nearestDeclaredValue(leaf, groupDefault);
  if (leaf.form === "list") {
    return containerOpensAnswered(
      leaf.list.isRequired,
      declaredEntries(declaredValue) !== undefined,
    )
      ? openingListEntries(declaredValue)
      : INACTIVE_LIST;
  }
  return declaredValue === undefined ? UNANSWERED_SCALAR : answeredScalar(declaredValue);
}

/**
 * Whether a section opens answered: a required group always, an optional one exactly while the
 * schema declared a value for it (its own `default`, a child's, or a collection's entries). An
 * empty declared object counts: `default: {}` says the member is there. A declared value drawn
 * unanswered would show nowhere while the schema's reading of the answer supplied it.
 */
function openingGroupDraft(group: SchemaGroupDescriptor) {
  // Asked of the descriptors, not the seeded nodes: a collection declared `[]` opens answered
  // with no rows, so counting what came out would read that as nothing.
  const isDeclared =
    group.defaultValue !== undefined ||
    group.entries.some((leaf) => nearestDeclaredValue(leaf, undefined) !== undefined);
  return containerOpensAnswered(group.isRequired, isDeclared)
    ? activeGroup(seededGroupMembers(group))
    : INACTIVE_GROUP;
}

/** One entry's opening node, from its item schema alone. */
function openingEntryDraft(item: SchemaFieldDescriptor): SchemaScalarDraft {
  if (item.defaultValue !== undefined) {
    return answeredScalar(item.defaultValue);
  }
  const displayed = emptyControlValue(item.kind);
  return displayed === undefined ? UNANSWERED_SCALAR : answeredScalar(displayed);
}
