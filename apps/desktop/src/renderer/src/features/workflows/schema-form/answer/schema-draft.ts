// The tree a drawn form edits; the answer is a projection of it (`schema-projection.ts`).
// A container's presence is a state (inactive or active), never a row count, and an unanswered
// scalar is a node, never `undefined` (JSON.stringify writes `undefined` in an array as `null`).
// Every write rebuilds rather than mutates, because React re-renders on the draft.

import type { SchemaMemberPath } from "../schema-member-path.js";

/** One control's draft: the value it composed, or the text it could not read as one. */
export type SchemaScalarDraft =
  | { readonly form: "scalar"; readonly state: "answered"; readonly value: unknown }
  | { readonly form: "scalar"; readonly state: "unanswered"; readonly unreadableText: string };

/** One entry of a collection: what it holds, and the identity it keeps as positions move. */
export interface SchemaListEntryDraft {
  /** Unique within this collection and never reused; React keys on it, not on position. */
  readonly entryId: string;
  readonly entry: SchemaScalarDraft;
}

/**
 * A collection's draft: inactive as a whole, or active holding its entries in order.
 * Presence is held here, not inferred from a count: zero rows is both "never answered" and
 * "emptied", and an optional array under `maxItems: 0` could otherwise never compose `[]`.
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

/** A control showing nothing, with no text behind it; shared so the empty state has one shape. */
export const UNANSWERED_SCALAR: SchemaScalarDraft = {
  form: "scalar",
  state: "unanswered",
  unreadableText: "",
};

/** A control that composed a value, whatever the schema goes on to say about it. */
export function answeredScalar(value: unknown): SchemaScalarDraft {
  return { form: "scalar", state: "answered", value };
}

/** A control showing text it cannot read as a value; the text lives on the unanswered arm alone. */
export function unansweredScalar(unreadableText: string): SchemaScalarDraft {
  return { form: "scalar", state: "unanswered", unreadableText };
}

/** The text one node is showing that it could not read, empty wherever it read it. */
export function unreadableTextOf(draft: SchemaScalarDraft | undefined): string {
  return draft?.state === "unanswered" ? draft.unreadableText : "";
}

function entryIdOf(ordinal: number): string {
  return `entry-${String(ordinal)}`;
}

/** A collection nobody has said they are answering. */
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

/** Every row one collection is drawing, which is none while it is inactive. */
export function listEntriesOf(list: SchemaListDraft | undefined): readonly SchemaListEntryDraft[] {
  return list?.state === "active" ? list.entries : [];
}

/**
 * One entry added at the end under a fresh id; adding a row answers the collection, so an
 * inactive collection becomes active.
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
 * One entry dropped; the ones that stay keep their ids and the ordinal is not wound back.
 * Removing the last entry leaves the collection active and empty (`[]`), not unanswered.
 */
export function withEntryRemoved(list: SchemaListDraft, index: number): SchemaListDraft {
  if (list.state !== "active") {
    return list;
  }
  return { ...list, entries: list.entries.filter((_held, at) => at !== index) };
}

/** A group nobody has said they are answering. */
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

/** One root member written, rebuilt rather than mutated. */
export function withNodeAt(
  draft: SchemaFormDraft,
  key: string,
  node: SchemaDraftNode,
): SchemaFormDraft {
  return { ...draft, [key]: node };
}

/** The group one root key names, or nothing where that key holds a leaf or nothing. */
export function groupDraftAt(
  draft: SchemaFormDraft,
  groupKey: string,
): SchemaGroupDraft | undefined {
  const node = draft[groupKey];
  return isGroupDraft(node) ? node : undefined;
}

/** The leaf one member path addresses; a path through an inactive group addresses nothing. */
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

/** Whether this node is a group, which is the one arm that has members rather than a value. */
function isGroupDraft(node: SchemaDraftNode | undefined): node is SchemaGroupDraft {
  return node?.form === "group";
}
