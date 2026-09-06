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
// `surface-registry.ts` gives about its own slots: a union written beside a
// hand-repeated array is two closed sets that agree until someone widens one.
//
// WHICH KINDS MAY BE TORN OFF IS DECIDED HERE TOO, AND DERIVED RATHER THAN DECLARED.
// `Spec-023 §Console Design (Meridian)` §The surface set names the detachable panes
// and the auxiliary windows in one sentence — "`timeline` and `agent-console` panes
// can be moved into their own hardened `BrowserWindow` — the two windows §Main
// Process Responsibilities names" — so the two sets are one set, and
// `src/shared/auxiliary-routes.ts` already declares it for the main process's menu
// and the renderer's route table.

import { AUXILIARY_ROUTE_NAMES } from "../../../../shared/auxiliary-routes.js";

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

// Consumed by T-023p-1C-2
/**
 * The pane kinds that may be torn off into an auxiliary window.
 *
 * The `readonly PaneKind[]` annotation is the load-bearing part, not decoration:
 * it is a compile error the day an auxiliary route names something this deck has
 * no pane kind for, which is the one way the window model and the deck could come
 * apart. Writing the two names again here instead would be a third copy of a
 * two-member set that agrees until someone widens one of the three.
 */
export const DETACHABLE_PANE_KINDS: readonly PaneKind[] = AUXILIARY_ROUTE_NAMES;

// Consumed by T-023p-1C-2
/**
 * Whether a pane of this kind may be torn off into a window of its own.
 *
 * A property of the KIND, answered once, and never a member a descriptor carries.
 * A pane whose body holds a main-process view (`browser`) or a process lease
 * (`terminal`) cannot follow a detach without its owning plan saying how — and a
 * per-descriptor boolean let each of the six view families answer that for itself,
 * which is six answers to a question the window model settles.
 */
export function isDetachablePaneKind(kind: PaneKind): boolean {
  return DETACHABLE_PANE_KINDS.includes(kind);
}
