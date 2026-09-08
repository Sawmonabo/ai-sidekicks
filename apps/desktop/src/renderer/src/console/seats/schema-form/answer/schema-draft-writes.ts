// What one control's change does to the draft, which is every write a drawn form makes.
//
// SPLIT FROM THE SEED BECAUSE THEY ARE TWO JOBS. `schema-answer.ts` reads the plan the
// mapper drew and says what each control OPENS holding; this module says what happens when
// somebody touches one. The seam is the module's own first sentence, and the two halves
// share nothing but the plan lookups and the opening nodes the seed exports — which is
// what a write needs when it lands somewhere the draft has nothing yet.
//
// EVERY WRITE REBUILDS RATHER THAN MUTATES, because the draft is the value React
// re-renders on. `schema-draft.ts` owns the rebuilds; this module owns which of them one
// act performs and where it lands.
//
// ANSWERING SOMETHING INSIDE A CONTAINER IS ANSWERING THE CONTAINER. A value written under
// a section nobody had opened opens that section at its own seed FIRST and then lands —
// the same state the control on its legend reaches, rather than a second, thinner
// activation that skipped the siblings — and a row added to a collection nobody had
// answered answers that collection the same way (`withEntryAppended`). Leaving either
// unanswered is the one act that takes it back out.

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
import type { SchemaMemberPath } from "../../../bridge/index.js";

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

/**
 * A collection opened or left unanswered, which is the one control its legend offers.
 *
 * THE GROUP'S RULE, ONE MEMBER OVER. Answering seeds the rows exactly as the mount would
 * have, so a collection answered later holds what it would have held had it been required.
 * Leaving it unanswered drops those rows: the collection is absent from the answer, and a
 * person who answers it again meets the seed rather than a half-remembered draft the
 * surface never showed them.
 *
 * Written through `withLeafDrafted` rather than at the root, so a collection inside a
 * section nobody has opened answers that section too — the same rule every other write in
 * this module keeps.
 */
export function withListActivation(
  plan: SchemaFormPlan,
  draft: SchemaFormDraft,
  memberPath: SchemaMemberPath,
  isActive: boolean,
): SchemaFormDraft {
  const list = listDrawnAt(plan, memberPath);
  if (list === undefined) {
    return draft;
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
  return drawn?.form === "list" ? answeredListDraft(drawn.list) : undefined;
}
