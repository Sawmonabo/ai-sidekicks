// The pane kinds, as one closed set.
//
// The set is closed and its members are fixed: `transcript`, `inspector`, `diff`,
// `workflow-run`, `workflow-builder`, `browser`, `terminal`, `agents`. The order below is
// the order `registeredPaneKinds()` answers in, and `pane-kinds.test.ts` compares this
// tuple with its own copy of the list by string equality rather than by eye.
//
// WHY THE SET IS DECLARED HERE AND NOT IN THE FAMILY THAT RENDERS EACH PANE
//
// Six view families each build two or three pane kinds at the same time. A set
// assembled from six per-family fragments could not answer "is this a pane kind?"
// until every fragment had loaded, and the one place that question is asked is
// layout restore — which runs before any pane has mounted. An unknown pane kind is
// dropped and reported; a validator that had to wait for the families to register
// would have nothing to drop against.
//
// The tuple is the declaration and the union is derived from it, for the reason
// `registries/screens/screen-registry.ts` gives about its own slots: a union written beside a
// hand-repeated array is two closed sets that agree until someone widens one.

/**
 * Every kind of pane the pane layout can hold, in the design's own order.
 *
 * Two members are built now and wired live only once the decisions behind them
 * land — `browser` (a main-process `WebContentsView`) and `terminal` (gated on the
 * write-lease surface). They are in the set because the set is what layout restore
 * validates against, and a pane kind absent from it would be dropped from a snapshot
 * rather than run against the fixture bridge, which is what is wanted until those
 * wires land.
 */
export const PANE_KINDS = [
  "transcript",
  "inspector",
  "diff",
  "workflow-run",
  "workflow-builder",
  "browser",
  "terminal",
  "agents",
] as const;

/** One pane kind. Derived from the enumeration, never restated. */
export type PaneKind = (typeof PANE_KINDS)[number];

/**
 * Whether an arbitrary value names a pane kind.
 *
 * Exists for exactly one caller shape: reading a persisted layout snapshot, where
 * the value came off disk and may predate or postdate this build. An unknown pane
 * kind is dropped and reported rather than rendered as a hole, and a drop needs a
 * predicate to drop against.
 */
export function isPaneKind(value: unknown): value is PaneKind {
  return typeof value === "string" && (PANE_KINDS as readonly string[]).includes(value);
}

/**
 * The pane kinds a layout snapshot never carries.
 *
 * The browser pane is EPHEMERAL: it is opened for a task and it is not part of the
 * session screen a person comes back to. The consequence is mechanical rather than aesthetic
 * — restoring one would ask the main process to attach a view host, load a page, and
 * spend a paying account's memory for a session nobody has opened yet, on every cold
 * start, forever.
 *
 * A PROPERTY OF THE KIND: a per-descriptor boolean lets each view family answer for
 * itself a question the layout model settles, and six answers to one question is how a
 * snapshot ends up holding a pane one family thought was durable. The annotation is
 * load-bearing: a name here that stops being a pane kind is a compile error.
 */
export const EPHEMERAL_PANE_KINDS: readonly PaneKind[] = ["browser"];

/**
 * Whether a pane of this kind is dropped from a layout snapshot rather than written.
 *
 * Both sides of the seam consult it, the write and the read, so a snapshot written by an
 * older build that did not have this rule still does not re-open the pane.
 */
export function isEphemeralPaneKind(kind: PaneKind): boolean {
  return EPHEMERAL_PANE_KINDS.includes(kind);
}
