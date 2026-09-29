// The entity vocabulary several layers name: the kinds the session store partitions by,
// and a reference to one entity.

/**
 * The entity kinds the console partitions by, in a stable order for tests and for
 * the gallery. Closed, and deliberately NOT the pane-kind set: a pane is a view of
 * an entity, and several pane kinds render the same kind of entity.
 *
 * Declared exactly once. The union below is derived from this array rather than
 * written beside it, because two hand-maintained copies of a closed set drift in
 * the direction nothing catches — a union member missing from the array leaves
 * `emptyPartitions` returning an object with a hole in it, and every read of that
 * partition is `undefined` at a type that says it cannot be.
 */
export const CONSOLE_ENTITY_KINDS = [
  "session",
  "user",
  "run",
  "agent",
  "workspace",
  "worktree",
  "artifact",
  "approval",
  // What a question to a person settled as: the partition the question-settlement
  // projector writes. Like `approval`, a projector fills it and no pane addresses it.
  "question",
  // Two workflow kinds, not one. A definition is authored, versioned, and scoped and
  // outlives every run of it; a run is one execution of one pinned version. The
  // builder addresses the first and the run pane the second, so filing both under
  // one partition would have a definition edit and a run transition invalidate each
  // other's selectors — and would give the two no way to be told apart by kind at
  // all, which is what a partitioned store keys on.
  "workflow-definition",
  "workflow-run",
  "browser-page",
  // The design track routes four entity kinds to the `inspector` pane — repo,
  // workspace, worktree, member — and `repo` is the one the console could not NAME.
  // `routing/panes/pane-address.ts` derives the inspector's scope from this vocabulary,
  // so its absence made a repo card unrepresentable at the address layer and made the
  // runtime scope table reject it as a kind mismatch, which would have forced the
  // repos branch to reopen this shared substrate to open a pane the design track
  // already routes.
  //
  // NO PROJECTOR IS OWED BY THIS ENTRY. A kind here is a valid REFERENCE kind and a
  // partition that exists; it is not a promise that some family projects rows into
  // it. An inspector card for a repo reads the row from its own family's reader, exactly
  // as it would if it had a partition full of rows, and the empty partition costs one
  // `Map` per session. The alternative was a second kind vocabulary for references that
  // the store does not fill, which is two closed sets for one idea.
  "repo",
] as const;

/** One entity kind. Derived from the enumeration, never restated. */
export type ConsoleEntityKind = (typeof CONSOLE_ENTITY_KINDS)[number];

/** A reference to one entity: its kind and its wire-verbatim identifier. */
export interface ConsoleEntityRef {
  readonly kind: ConsoleEntityKind;
  readonly id: string;
}
