// The deck's pane kinds, as one closed set.
//
// `Spec-023 §Console Design (Meridian)` fixes this set and fixes its members:
// "Pane kinds, a closed set: `timeline` (session- or channel-scoped),
// `inspector`, `runs`, `approvals`, `diff`, `artifact`, `workflow-run`,
// `workflow-builder`, `browser`, `terminal`, `agent-console`." The order below is
// the spec bullet's own order, and `pane-kinds.test.ts` compares the two by string
// equality rather than by eye.
//
// WHY THE SET IS DECLARED HERE AND NOT IN THE FAMILY THAT RENDERS EACH PANE
//
// Six view families each build two or three pane kinds at the same time. A set
// assembled from six per-family fragments could not answer "is this a pane kind?"
// until every fragment had loaded, and the one place that question is asked is
// layout restore — which runs before any pane has mounted. The spec says an
// unknown pane kind is "dropped and reported"; a validator that had to wait for
// the families to register would have nothing to drop against.
//
// The tuple is the declaration and the union is derived from it, for the reason
// `frame/surface-registry.ts` gives about its own slots: a union written beside a
// hand-repeated array is two closed sets that agree until someone widens one.

// Consumed by T-023p-1C-2
/**
 * Every kind of pane the deck can hold, in `Spec-023`'s own order.
 *
 * Two members are built now and wired live only behind their governing
 * amendments — `browser` (a main-process `WebContentsView`, gated on its Type-2
 * ADR) and `terminal` (gated on the Spec-003 write-lease surface). They are in
 * the set because the set is what layout restore validates against, and a pane
 * kind absent from it would be dropped from a snapshot rather than run against
 * the fixture bridge, which is what the spec asks for until those wires land.
 */
export const PANE_KINDS = [
  "timeline",
  "inspector",
  "runs",
  "approvals",
  "diff",
  "artifact",
  "workflow-run",
  "workflow-builder",
  "browser",
  "terminal",
  "agent-console",
] as const;

/** One pane kind. Derived from the enumeration, never restated. */
export type PaneKind = (typeof PANE_KINDS)[number];

// Consumed by T-023p-1C-2
/**
 * Whether an arbitrary value names a pane kind.
 *
 * Exists for exactly one caller shape: reading a persisted layout snapshot, where
 * the value came off disk and may predate or postdate this build. `Spec-023
 * §Console Design (Meridian)` requires that "an unknown pane kind is dropped and
 * reported" rather than rendered as a hole, and a drop needs a predicate to drop
 * against.
 */
export function isPaneKind(value: unknown): value is PaneKind {
  return typeof value === "string" && (PANE_KINDS as readonly string[]).includes(value);
}
