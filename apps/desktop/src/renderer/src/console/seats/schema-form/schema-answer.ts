// What a drawn form OPENS holding, and the plan lookups every reader of it makes.
//
// THE SEED BUILDS A DRAFT AND NOT AN ANSWER. `schema-draft.ts` states the representation;
// this module is the half that reads the plan the mapper drew, so a node is opened for
// every control on the screen and for nothing else. The answer is a PROJECTION of what
// this seeds (`schema-projection.ts`), which is what makes the value the validator checks
// and the value a submission sends the same bytes by construction. What one control's
// CHANGE does to that draft is `schema-draft-writes.ts`, split off at this module's own
// seam once the two jobs had outgrown one file.
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
// A CONTROL THE SCHEMA DECLARED NO VALUE FOR OPENS UNANSWERED, WHICH IS ONE NODE AND NOT
// A VALUE. What an unanswered node is WORTH is decided once, in the projection, out of
// `schema-fields.ts`'s presence rule — so this module never has to know that a required
// box opens at `false` while a required number box opens at nothing.
//
// AN OPTIONAL CONTAINER OPENS INACTIVE UNLESS THE SCHEMA DECLARED A VALUE FOR IT, which
// is `containerOpensAnswered` in `schema-fields.ts` and is read here for both of them. A
// collection is the group's case one member over: an optional array seeded through its
// rows alone was absent at zero rows and present at one, so `[]` — the only answer a root
// demanding one member and a `maxItems: 0` array accepts — was unreachable. A declared
// `default: []` counts on its own for the same reason `default: {}` does, and the
// paragraph below is that same rule told from the group's side.
//
// AN OPTIONAL GROUP OPENS INACTIVE UNLESS THE SCHEMA DECLARED A VALUE FOR IT. Seeded
// through its children on their own requiredness, an optional `settings` holding a
// required boolean `enabled` opened as `{ settings: { enabled: false } }` and the box
// could only ever replace that with `true` or `false` — so a schema that accepts or
// requires the whole group to be ABSENT could never be satisfied through the drawn form.
// It opens inactive instead, and a person activates it on its legend. A group the schema
// declared a VALUE for — its own `default`, a child's, or a collection's entries — is the
// same rule read from the other side rather than an exception to it: the schema has
// stated a value, something on the screen has to be displaying it, so the section opens
// answered with its children showing what was declared.
//
// A GROUP'S OWN `default` IS SEEDED THROUGH ITS CHILDREN AND NEVER AS AN OBJECT. A group
// is a container: no control displays its object, so writing that object whole would put
// a member into the submission nothing on the screen accounts for. So the seed takes the
// NEAREST declared value on a member's path: the control's own where it has one, else the
// enclosing group's projected at that member's key. A group default a child could not show
// never reaches here at all — the mapper sends that schema to the raw editor.

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
} from "./schema-fields.js";
import { asAnswerRecord, type SchemaFormAnswer } from "./schema-answer-paths.js";
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
 * A collection's declared `default`, taken only where it declared a list.
 *
 * Narrowed HERE, before the entries are minted, rather than trusted from the descriptor:
 * a `default` of another shape is one the compiled validator refuses on its own terms, and
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

/** The rows a collection opens holding once somebody IS answering it. */
function openingListEntries(declaredValue: unknown): SchemaListDraft {
  return listDraftOf((declaredEntries(declaredValue) ?? []).map(answeredScalar));
}

/**
 * A collection's node once somebody is answering it, holding whatever the schema declared.
 *
 * Exported for the write path, which needs it at exactly two moments: when the control on
 * a collection's legend answers it, and when a list act lands on a collection the draft
 * holds no node for. Both want the node the mount would have built, which is this one.
 */
export function answeredListDraft(list: SchemaListDescriptor): SchemaListDraft {
  return openingListEntries(list.defaultValue);
}

/** One leaf's opening node: its declared value where the schema wrote one, else nothing. */
function openingLeafDraft(
  leaf: SchemaLeafEntry,
  groupDefault: SchemaFormAnswer | undefined,
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

/** Every member of one group, opened at whatever that group and its controls declared. */
export function seededGroupMembers(group: SchemaGroupDescriptor): SchemaGroupMembersDraft {
  const groupDefault = asAnswerRecord(group.defaultValue);
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
 * The draft a drawn form opens with: every control's own declared value, and nothing else.
 *
 * Read ONCE, at the mount. A seed recomputed when the schema's identity changed would
 * discard what somebody had typed every time a run read refreshed and handed down an
 * equal schema as a new object.
 *
 * Walked as entries rather than as flattened leaves, because a group's declared value has
 * to travel with the leaves it names: flattened, the only thing left of the group is the
 * path segment its children carry, and the value would have nowhere to be read from.
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
 * Whether a section opens answered.
 *
 * ONE RULE AND NOT TWO: a required group always, and an optional one exactly while the
 * schema declared a VALUE for it — its own `default`, whatever that object names, or a
 * child's own, or a collection's opening entries. An empty declared object counts, and
 * counts on its own: `default: {}` is the schema saying the member is there, so the
 * section is answered even though no child came out of the seed holding anything. A
 * section holding a declared value and drawn unanswered would show that value nowhere
 * while the schema's own reading of the answer supplied it, which is the divergence this
 * whole module exists to close; a section the schema declared nothing for has nothing to
 * display, so it opens inactive and a person answers it on its legend.
 */
function openingGroupDraft(group: SchemaGroupDescriptor) {
  // Asked of the DESCRIPTORS rather than of the nodes they seeded, because a seeded node
  // no longer answers it: a collection the schema declared `[]` for opens answered holding
  // no rows, so counting what came out would read that declaration as nothing at all.
  const isDeclared =
    group.defaultValue !== undefined ||
    group.entries.some((leaf) => nearestDeclaredValue(leaf, undefined) !== undefined);
  return containerOpensAnswered(group.isRequired, isDeclared)
    ? activeGroup(seededGroupMembers(group))
    : INACTIVE_GROUP;
}

/**
 * What an entry added to this collection opens holding.
 *
 * The item schema's own declared value where it has one, and otherwise whatever an
 * untouched control of that kind is DISPLAYING — the shared table in `schema-fields.ts`,
 * so a repeated control and a standalone one of the same kind open at the same value. The
 * three kinds whose empty display is worth nothing open UNANSWERED, which is the node the
 * answer has no way to hold: written into the array as `undefined`, that row serialized
 * as `null`, so the validator read one value and the daemon would have received another
 * while the blank control displayed neither.
 *
 * A path the plan drew no collection for is a caller asking about one this form does not
 * have. There is no control there to derive an opening node from, so there is no node.
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

/** One entry's opening node, from its item schema alone. */
function openingEntryDraft(item: SchemaFieldDescriptor): SchemaScalarDraft {
  if (item.defaultValue !== undefined) {
    return answeredScalar(item.defaultValue);
  }
  const displayed = emptyControlValue(item.kind);
  return displayed === undefined ? UNANSWERED_SCALAR : answeredScalar(displayed);
}
