// What one control's change does to the draft, which is every write a drawn form makes. The seed
// (`schema-answer.ts`) says what each control opens holding; this says what happens when somebody
// touches one. Every write rebuilds rather than mutates, since the draft is what React re-renders
// on (`schema-draft.ts` owns the rebuilds). Answering something inside an unopened section or an
// unanswered collection answers the container first, at its own seed, as its legend control does.

import {
  activeGroup,
  groupDraftAt,
  INACTIVE_GROUP,
  INACTIVE_LIST,
  leafDraftAt,
  withEntryAppended,
  withEntryDrafted,
  withEntryRemoved,
  withGroupMember,
  withNodeAt,
  type SchemaFormDraft,
  type SchemaLeafDraft,
  type SchemaScalarDraft,
} from "./schema-draft.js";
import {
  answeredListDraft,
  groupDrawnUnder,
  leafDrawnAt,
  listDrawnAt,
  newListEntryDraft,
  seededGroupMembers,
} from "./schema-answer.js";
import { memberKeyOf, type SchemaFormPlan } from "../plan/schema-fields.js";
import { encodeMemberPointer, type SchemaMemberPath } from "../schema-member-path.js";

/**
 * Write one leaf at its path, activating the group it sits in where that group is not yet. The one
 * write path for a drawn control: a write under an inactive group opens it at its own seed first,
 * the same state its legend control reaches.
 */
export function withLeafDrafted(
  plan: SchemaFormPlan,
  draft: SchemaFormDraft,
  memberPath: SchemaMemberPath,
  leaf: SchemaLeafDraft,
): SchemaFormDraft {
  const [leading, ...rest] = memberPath;
  if (leading === undefined) {
    return undrawnMember(memberPath);
  }
  const head = String(leading);
  if (rest.length === 0) {
    return withNodeAt(draft, head, leaf);
  }
  const group = groupDrawnUnder(plan, head);
  if (group === undefined) {
    return undrawnMember(memberPath);
  }
  const held = groupDraftAt(draft, head);
  const members = held?.state === "active" ? held.members : seededGroupMembers(group);
  return withNodeAt(draft, head, activeGroup(withGroupMember(members, String(rest[0]), leaf)));
}

/**
 * A group opened or left unanswered, the one control its legend offers. Activating seeds the
 * members as the mount would; leaving it unanswered drops them, so reopening meets the seed and
 * not a half-remembered draft the form never showed.
 */
export function withGroupActivation(
  plan: SchemaFormPlan,
  draft: SchemaFormDraft,
  memberPath: SchemaMemberPath,
  isActive: boolean,
): SchemaFormDraft {
  const groupKey = memberKeyOf(memberPath);
  const group = groupKey === undefined ? undefined : groupDrawnUnder(plan, groupKey);
  if (groupKey === undefined || group === undefined) {
    return undrawnMember(memberPath);
  }
  return withNodeAt(
    draft,
    groupKey,
    isActive ? activeGroup(seededGroupMembers(group)) : INACTIVE_GROUP,
  );
}

/**
 * A collection opened or left unanswered, the group's rule one member over. Written through
 * `withLeafDrafted`, so a collection inside an unopened section answers that section too.
 */
export function withListActivation(
  plan: SchemaFormPlan,
  draft: SchemaFormDraft,
  memberPath: SchemaMemberPath,
  isActive: boolean,
): SchemaFormDraft {
  const list = listDrawnAt(plan, memberPath);
  if (list === undefined) {
    return undrawnMember(memberPath);
  }
  return withLeafDrafted(
    plan,
    draft,
    memberPath,
    isActive ? answeredListDraft(list) : INACTIVE_LIST,
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
    return undrawnMember(memberPath);
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
    ? undrawnMember(memberPath)
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
    ? undrawnMember(memberPath)
    : withLeafDrafted(plan, draft, memberPath, withEntryRemoved(held, index));
}

/**
 * The collection this draft holds at one path, opened at its seed where it holds none. A
 * collection inside an inactive group has no node yet, and the list acts are reachable only from
 * a drawn row.
 */
function heldListDraft(plan: SchemaFormPlan, draft: SchemaFormDraft, memberPath: SchemaMemberPath) {
  const leaf = leafDraftAt(draft, memberPath);
  if (leaf?.form === "list") {
    return leaf;
  }
  const drawn = leafDrawnAt(plan, memberPath);
  return drawn?.form === "list" ? answeredListDraft(drawn.list) : undefined;
}

/**
 * A write addressed at a member no control is drawn for. Every write comes from a drawn control,
 * so reaching this is a defect in the form, raised rather than dropped as a silent no-op.
 */
function undrawnMember(memberPath: SchemaMemberPath): never {
  throw new Error(`No control is drawn at "${encodeMemberPointer(memberPath)}".`);
}
