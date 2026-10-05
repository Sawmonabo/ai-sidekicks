/**
 * Every kind of pane the pane layout can hold, in the design's order.
 *
 * The set is declared here rather than assembled from per-feature registrations because layout
 * restore validates against it before any pane has mounted. `browser` and `terminal` are in it
 * even where their live wiring is pending, so a snapshot holding one is not dropped. The tuple
 * is the declaration and `PaneKind` is derived from it, so the two cannot disagree.
 */
export const PANE_KINDS = [
  "transcript",
  "inspector",
  "diff",
  "workflow-builder",
  "browser",
  "terminal",
  "agents",
] as const;

/** One pane kind, derived from `PANE_KINDS`. */
export type PaneKind = (typeof PANE_KINDS)[number];

/**
 * Whether an arbitrary value names a pane kind.
 *
 * For reading a persisted layout snapshot, where the value came off disk and may name a kind
 * this build does not have; an unknown kind is dropped and reported.
 */
export function isPaneKind(value: unknown): value is PaneKind {
  return typeof value === "string" && (PANE_KINDS as readonly string[]).includes(value);
}

/**
 * The pane kinds a layout snapshot never carries.
 *
 * The browser pane is ephemeral: it is opened for a task and is not part of the session screen
 * a person comes back to, and restoring one would attach a view host and load a page on every
 * cold start. It is a property of the kind so one layout rule answers for every feature.
 */
export const EPHEMERAL_PANE_KINDS: readonly PaneKind[] = ["browser"];

/**
 * Whether a pane of this kind is dropped from a layout snapshot rather than written.
 * Both the write and the read consult it.
 */
export function isEphemeralPaneKind(kind: PaneKind): boolean {
  return EPHEMERAL_PANE_KINDS.includes(kind);
}
