// What a drawn form OPENS holding, and what one control's change does to the draft.
//
// THE SEED BUILDS A DRAFT AND NOT AN ANSWER. `schema-draft.ts` states the representation;
// this module is the half that reads the plan the mapper drew, so a node is opened for
// every control on the screen and for nothing else. The answer is a PROJECTION of what
// this seeds (`schema-projection.ts`), which is what makes the value the validator checks
// and the value a submission sends the same bytes by construction.
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
  leafDraftAt,
  listDraftOf,
  NOTHING_DRAFTED,
  UNANSWERED_SCALAR,
  withEntryAppended,
  withEntryDrafted,
  withEntryRemoved,
  withGroupMember,
  withNodeAt,
  groupDraftAt,
  type SchemaFormDraft,
  type SchemaGroupMembersDraft,
  type SchemaLeafDraft,
  type SchemaScalarDraft,
} from "./schema-draft.js";
import {
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

/** One leaf's opening node: its declared value where the schema wrote one, else nothing. */
function openingLeafDraft(
  leaf: SchemaLeafEntry,
  groupDefault: SchemaFormAnswer | undefined,
): SchemaLeafDraft {
  const declaredValue = nearestDeclaredValue(leaf, groupDefault);
  if (leaf.form === "list") {
    return listDraftOf((declaredEntries(declaredValue) ?? []).map(answeredScalar));
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
  const members = seededGroupMembers(group);
  const isDeclared =
    group.defaultValue !== undefined || Object.values(members).some(holdsDeclaredValue);
  return group.isRequired || isDeclared ? activeGroup(members) : INACTIVE_GROUP;
}

/** Whether one seeded leaf came out of the schema holding something rather than nothing. */
function holdsDeclaredValue(leaf: SchemaLeafDraft): boolean {
  return leaf.form === "list" ? leaf.entries.length > 0 : leaf.state === "answered";
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

/**
 * Write one leaf at its path, activating the group it sits in where that group is not yet.
 *
 * THE ONE WRITE PATH FOR A DRAWN CONTROL, and the reason it takes the plan. Answering a
 * member of a section IS answering the section, so a write under an inactive group opens
 * that group at its own seed FIRST and then lands the value — the same state activating
 * it on the legend reaches, rather than a second, thinner activation that skipped the
 * siblings.
 */
export function withLeafDrafted(
  plan: SchemaFormPlan,
  draft: SchemaFormDraft,
  memberPath: SchemaMemberPath,
  leaf: SchemaLeafDraft,
): SchemaFormDraft {
  const [leading, ...rest] = memberPath;
  if (leading === undefined) {
    return draft;
  }
  const head = String(leading);
  if (rest.length === 0) {
    return withNodeAt(draft, head, leaf);
  }
  const group = groupDrawnUnder(plan, head);
  if (group === undefined) {
    return draft;
  }
  const held = groupDraftAt(draft, head);
  const members = held?.state === "active" ? held.members : seededGroupMembers(group);
  return withNodeAt(draft, head, activeGroup(withGroupMember(members, String(rest[0]), leaf)));
}

/**
 * A group opened or left unanswered, which is the one control a group's legend offers.
 *
 * Activating seeds the members exactly as the mount would have, so a section answered
 * later holds what it would have held had it been required. Leaving it unanswered drops
 * those members: the group is absent from the answer, and a person who opens it again
 * meets the seed rather than a half-remembered draft the surface never showed them.
 */
export function withGroupActivation(
  plan: SchemaFormPlan,
  draft: SchemaFormDraft,
  memberPath: SchemaMemberPath,
  isActive: boolean,
): SchemaFormDraft {
  const groupKey = memberKeyOf(memberPath);
  if (groupKey === undefined) {
    return draft;
  }
  const group = groupDrawnUnder(plan, groupKey);
  if (group === undefined) {
    return draft;
  }
  return withNodeAt(
    draft,
    groupKey,
    isActive ? activeGroup(seededGroupMembers(group)) : INACTIVE_GROUP,
  );
}

/** One entry appended to a collection, at whatever an added entry opens holding. */
export function withListEntryAppended(
  plan: SchemaFormPlan,
  draft: SchemaFormDraft,
  memberPath: SchemaMemberPath,
): SchemaFormDraft {
  const held = heldListDraft(plan, draft, memberPath);
  const added = newListEntryDraft(plan, memberPath);
  if (held === undefined || added === undefined) {
    return draft;
  }
  return withLeafDrafted(plan, draft, memberPath, withEntryAppended(held, added));
}

/** One entry of a collection replaced, keeping the identity that entry already carries. */
export function withListEntryDrafted(
  plan: SchemaFormPlan,
  draft: SchemaFormDraft,
  memberPath: SchemaMemberPath,
  index: number,
  entry: SchemaScalarDraft,
): SchemaFormDraft {
  const held = heldListDraft(plan, draft, memberPath);
  return held === undefined
    ? draft
    : withLeafDrafted(plan, draft, memberPath, withEntryDrafted(held, index, entry));
}

/** One entry dropped, with every entry that stays keeping its own id and its own draft. */
export function withListEntryRemoved(
  plan: SchemaFormPlan,
  draft: SchemaFormDraft,
  memberPath: SchemaMemberPath,
  index: number,
): SchemaFormDraft {
  const held = heldListDraft(plan, draft, memberPath);
  return held === undefined
    ? draft
    : withLeafDrafted(plan, draft, memberPath, withEntryRemoved(held, index));
}

/**
 * The collection this draft holds at one path, opened at its seed where it holds none.
 *
 * A collection inside a group nobody has activated has no node yet, and the three list
 * acts are reachable only from a drawn row — so the seed is what those acts start from,
 * and the write path above is what activates the group around it.
 */
function heldListDraft(plan: SchemaFormPlan, draft: SchemaFormDraft, memberPath: SchemaMemberPath) {
  const leaf = leafDraftAt(draft, memberPath);
  if (leaf?.form === "list") {
    return leaf;
  }
  const drawn = leafDrawnAt(plan, memberPath);
  if (drawn?.form !== "list") {
    return undefined;
  }
  const opened = openingLeafDraft(drawn, undefined);
  return opened.form === "list" ? opened : undefined;
}
