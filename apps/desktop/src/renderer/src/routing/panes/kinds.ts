/**
 * Every kind of pane the pane layout can hold, in the order the interface lists them.
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
 * The pane kinds a session's pane block holds: every kind but the transcript, which the
 * conversation beside the block draws.
 */
export type BlockPaneKind = Exclude<PaneKind, "transcript">;

/**
 * Whether an arbitrary value names a pane kind.
 *
 * For reading a persisted layout snapshot, where the value came off disk and may name a kind
 * this build does not have; an unknown kind is dropped and reported.
 */
export function isPaneKind(value: unknown): value is PaneKind {
  return typeof value === "string" && (PANE_KINDS as readonly string[]).includes(value);
}

/** Whether a pane of this kind stands in the pane block rather than in the conversation. */
export function isBlockPaneKind(kind: PaneKind): kind is BlockPaneKind {
  return kind !== "transcript";
}
