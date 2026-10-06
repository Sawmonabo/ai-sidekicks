// The entity vocabulary several layers name: the kinds the session store partitions by, and a
// reference to one entity.

/**
 * The entity kinds the app partitions by, in a stable order. Not the pane-kind set: a pane
 * is a view of an entity, and several pane kinds render the same kind of entity.
 */
export const ENTITY_KINDS = [
  "session",
  "user",
  "run",
  "agent",
  "workspace",
  "worktree",
  "artifact",
  "approval",
  // What a question to a person settled as.
  "question",
  // Two workflow kinds: a definition is authored and versioned and outlives its runs, a run
  // executes one pinned version. One partition would make an edit and a run transition
  // invalidate each other's selectors.
  "workflow-definition",
  "workflow-run",
  "browser-page",
  // A valid reference kind with a partition of its own, not a promise that a feature projects
  // rows into it; the empty partition costs one `Map` per session. The total map over this
  // vocabulary in `routing/panes/address.ts` names it too (as not admitting a checkout).
  "repo",
] as const;

/** One entity kind. */
export type EntityKind = (typeof ENTITY_KINDS)[number];

/** A reference to one entity: its kind and its wire-verbatim identifier. */
export interface EntityRef {
  readonly kind: EntityKind;
  readonly id: string;
}
