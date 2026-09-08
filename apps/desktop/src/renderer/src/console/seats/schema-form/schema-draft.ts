// The tree a drawn form EDITS, and the three things it can say that a JSON value cannot.
//
// THE DRAFT IS A TREE AND THE ANSWER IS A PROJECTION OF IT (`schema-projection.ts`). One
// node per member the plan drew:
//
//   - a SCALAR node is `answered`, holding the value its control composed, or
//     `unanswered`, carrying the control-local text that control could not read as a
//     value and nothing else;
//   - a GROUP node is `inactive` — optional, and nobody has said they are answering it —
//     or `active`, holding one leaf node per member;
//   - a LIST node is `inactive` — optional, and nobody has said they are answering it —
//     or `active`, holding entries, each carrying its own scalar node and a STABLE ENTRY
//     ID minted when the entry was added, never its position.
//
// A CONTAINER'S PRESENCE IS A STATE AND NEVER A COUNT. Zero rows is what a collection
// nobody has answered looks like and what one somebody emptied looks like, so a projection
// reading the count alone could compose `absent` or `[one row]` and never `[]`. The two
// containers therefore carry the same two states, and `schema-fields.ts` states the one
// rule both are read by.
//
// `unanswered` AND `inactive` ARE NODES, NEVER `undefined` AND NEVER A SENTINEL INSIDE A
// JSON VALUE. An added list entry nobody had answered used to sit in the answer's array as
// `undefined`, and `JSON.stringify` writes that position as `null` — so the local
// validator checked one value, the daemon would have received another, and the blank
// control displayed neither. A state the answer has no way to hold is held HERE, where the
// answer never sees it, and the projection is where each node becomes a member or does not.
//
// AN ENTRY ID IS THE ENTRY'S IDENTITY AND ITS POSITION IS ONLY WHERE IT SITS. Keyed by
// index, a React subtree carrying per-entry control state — the unreadable text above —
// was reused or unmounted under the wrong entry when an earlier one was removed, so an
// invalid figure moved to a neighbour or disappeared. The ids come from a counter the list
// itself carries, so nothing here reads a clock, a random source, or module state, and the
// same edits over the same draft mint the same ids.
//
// NOTHING HERE READS A PLAN, A DESCRIPTOR, OR A SCHEMA. What a member is worth while
// nobody has answered it is the presence rule in `schema-fields.ts`, asked by the
// projection; what a form OPENS holding is `schema-answer.ts`. This module is the
// representation and the writes over it — and every write rebuilds rather than mutates,
// because the draft is the value React re-renders on.

import type { SchemaMemberPath } from "../../bridge/index.js";

/** One control's draft: the value it composed, or the text it could not read as one. */
export type SchemaScalarDraft =
  | { readonly form: "scalar"; readonly state: "answered"; readonly value: unknown }
  | { readonly form: "scalar"; readonly state: "unanswered"; readonly unreadableText: string };

/** One entry of a collection: what it holds, and the identity it keeps as positions move. */
export interface SchemaListEntryDraft {
  /** Minted when the entry was added. Unique within this collection and never reused. */
  readonly entryId: string;
  readonly entry: SchemaScalarDraft;
}

/**
 * A collection's draft: unanswered as a whole, or answered holding its entries in order.
 *
 * THE SAME TWO STATES A GROUP HAS, AND FOR THE SAME REASON. An optional collection has no
 * state its rows can show: zero rows is what a collection nobody has answered looks like
 * AND what one somebody emptied looks like, so an answer projected from the rows alone
 * could reach `absent` or `[one row]` and never `[]`. A schema that tells those apart — an
 * optional array under `maxItems: 0` at a root demanding one member — then had exactly one
 * valid answer and no way to compose it. The presence is held HERE, beside the group's,
 * rather than inferred from a count.
 */
export type SchemaListDraft =
  | { readonly form: "list"; readonly state: "inactive" }
  | {
      readonly form: "list";
      readonly state: "active";
      readonly entries: readonly SchemaListEntryDraft[];
      /** The ordinal the next added entry takes. Never reused and never wound back. */
      readonly nextEntryOrdinal: number;
    };

/** What a group may hold, which is what its descriptor holds: a control or a list of one. */
export type SchemaLeafDraft = SchemaScalarDraft | SchemaListDraft;

/** One group's members, by the key each of them answers under. */
export type SchemaGroupMembersDraft = Readonly<Record<string, SchemaLeafDraft>>;

/** A group's draft: unanswered as a whole, or active with one node per member. */
export type SchemaGroupDraft =
  | { readonly form: "group"; readonly state: "inactive" }
  | {
      readonly form: "group";
      readonly state: "active";
      readonly members: SchemaGroupMembersDraft;
    };

/** Anything the form's root may hold. */
export type SchemaDraftNode = SchemaLeafDraft | SchemaGroupDraft;

/** The whole draft: one node per member the plan drew at the root. */
export type SchemaFormDraft = Readonly<Record<string, SchemaDraftNode>>;

/** The draft a form with no drawn controls holds. Never written to; only ever replaced. */
export const NOTHING_DRAFTED: SchemaFormDraft = {};

/**
 * A control showing nothing at all, with no text behind it.
 *
 * Held rather than composed at each of its call sites, because five of the six controls
 * report exactly this value and a literal repeated six times is six places for the empty
 * text to become something else.
 */
export const UNANSWERED_SCALAR: SchemaScalarDraft = {
  form: "scalar",
  state: "unanswered",
  unreadableText: "",
};

/** A control that composed a value, whatever the schema goes on to say about it. */
export function answeredScalar(value: unknown): SchemaScalarDraft {
  return { form: "scalar", state: "answered", value };
}

/**
 * A control showing text it cannot read as a value.
 *
 * The text rides the UNANSWERED arm alone, which is the control's own invariant made
 * structural: the moment what a person typed reads as a value, the value is what the node
 * holds and there is nothing left over to show.
 */
export function unansweredScalar(unreadableText: string): SchemaScalarDraft {
  return { form: "scalar", state: "unanswered", unreadableText };
}

/** The text one node is showing that it could not read, empty wherever it read it. */
export function unreadableTextOf(draft: SchemaScalarDraft | undefined): string {
  return draft?.state === "unanswered" ? draft.unreadableText : "";
}

/** One entry's id, spelled so a reader meets an identity rather than a bare number. */
function entryIdOf(ordinal: number): string {
  return `entry-${String(ordinal)}`;
}

/** A collection nobody has said they are answering. Held for the reason the scalar one is. */
export const INACTIVE_LIST: SchemaListDraft = { form: "list", state: "inactive" };

/** A collection somebody is answering, holding these entries under ids minted in order. */
export function listDraftOf(entries: readonly SchemaScalarDraft[]): SchemaListDraft {
  return {
    form: "list",
    state: "active",
    entries: entries.map((entry, ordinal) => ({ entryId: entryIdOf(ordinal), entry })),
    nextEntryOrdinal: entries.length,
  };
}

/**
 * Every row one collection is drawing, which is none at all while nobody is answering it.
 *
 * The one reader of the inactive arm, so no surface asks a collection for entries it
 * cannot have: a row under a collection nobody is answering would be a row whose value
 * reaches nothing, exactly as a control under an inactive group would.
 */
export function listEntriesOf(list: SchemaListDraft | undefined): readonly SchemaListEntryDraft[] {
  return list?.state === "active" ? list.entries : [];
}

/**
 * One entry added at the end, under an id no entry of this collection has ever carried.
 *
 * ADDING A ROW IS ANSWERING THE COLLECTION, which is the same rule the write path keeps
 * one level up when a value lands inside a section nobody had opened: the act that puts
 * something in a container is what makes the container present.
 */
export function withEntryAppended(
  list: SchemaListDraft,
  entry: SchemaScalarDraft,
): SchemaListDraft {
  const nextEntryOrdinal = list.state === "active" ? list.nextEntryOrdinal : 0;
  return {
    form: "list",
    state: "active",
    entries: [...listEntriesOf(list), { entryId: entryIdOf(nextEntryOrdinal), entry }],
    nextEntryOrdinal: nextEntryOrdinal + 1,
  };
}

/** One entry's value replaced, keeping the identity that entry already carries. */
export function withEntryDrafted(
  list: SchemaListDraft,
  index: number,
  entry: SchemaScalarDraft,
): SchemaListDraft {
  if (list.state !== "active") {
    return list;
  }
  return {
    ...list,
    entries: list.entries.map((held, at) =>
      at === index ? { entryId: held.entryId, entry } : held,
    ),
  };
}

/**
 * One entry dropped, with every entry that stays keeping its own id.
 *
 * The ordinal is not wound back: a later add takes the next unused id rather than the one
 * the departed entry had, so no React subtree is ever handed a key a different entry used
 * to answer to.
 *
 * AND THE LAST ONE LEAVING DOES NOT CLOSE THE COLLECTION. A collection somebody answered
 * and then emptied is an empty array, not a member they never answered — only the control
 * on its legend moves it back out of the answer.
 */
export function withEntryRemoved(list: SchemaListDraft, index: number): SchemaListDraft {
  if (list.state !== "active") {
    return list;
  }
  return { ...list, entries: list.entries.filter((_held, at) => at !== index) };
}

/** A group nobody has said they are answering. Held for the reason the scalar one is. */
export const INACTIVE_GROUP: SchemaGroupDraft = { form: "group", state: "inactive" };

/** A group somebody is answering, holding one node per member. */
export function activeGroup(members: SchemaGroupMembersDraft): SchemaGroupDraft {
  return { form: "group", state: "active", members };
}

/** One member of a group written into its members, rebuilt rather than mutated. */
export function withGroupMember(
  members: SchemaGroupMembersDraft,
  key: string,
  leaf: SchemaLeafDraft,
): SchemaGroupMembersDraft {
  return { ...members, [key]: leaf };
}

/** One root member written, rebuilt rather than mutated for the header's reason. */
export function withNodeAt(
  draft: SchemaFormDraft,
  key: string,
  node: SchemaDraftNode,
): SchemaFormDraft {
  return { ...draft, [key]: node };
}

/** Whether this node is a group, which is the one arm that has members rather than a value. */
function isGroupDraft(node: SchemaDraftNode | undefined): node is SchemaGroupDraft {
  return node?.form === "group";
}

/** The group one root key names, or nothing where that key holds a leaf or nothing. */
export function groupDraftAt(
  draft: SchemaFormDraft,
  groupKey: string,
): SchemaGroupDraft | undefined {
  const node = draft[groupKey];
  return isGroupDraft(node) ? node : undefined;
}

/**
 * The leaf one member path addresses, or nothing where the draft holds none there.
 *
 * One segment reads the root and two read through a group, and a path through an INACTIVE
 * group answers nothing — which is the representation saying what it means: an inactive
 * group holds no members at all, so there is no node under it to read.
 */
export function leafDraftAt(
  draft: SchemaFormDraft,
  memberPath: SchemaMemberPath,
): SchemaLeafDraft | undefined {
  const [leading, ...rest] = memberPath;
  if (leading === undefined) {
    return undefined;
  }
  const head = String(leading);
  if (rest.length === 0) {
    const node = draft[head];
    return isGroupDraft(node) ? undefined : node;
  }
  const group = groupDraftAt(draft, head);
  return group?.state === "active" ? group.members[String(rest[0])] : undefined;
}

/** The scalar one member path addresses, or nothing where it addresses a collection. */
export function scalarDraftAt(
  draft: SchemaFormDraft,
  memberPath: SchemaMemberPath,
): SchemaScalarDraft | undefined {
  const leaf = leafDraftAt(draft, memberPath);
  return leaf?.form === "scalar" ? leaf : undefined;
}

/** The collection one member path addresses, or nothing where it addresses a control. */
export function listDraftAt(
  draft: SchemaFormDraft,
  memberPath: SchemaMemberPath,
): SchemaListDraft | undefined {
  const leaf = leafDraftAt(draft, memberPath);
  return leaf?.form === "list" ? leaf : undefined;
}
