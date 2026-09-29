// What a workflows body is showing, as one closed set.
//
// The run view and the node-graph builder each answer the same question before they
// answer their own: is there anything here yet, and if not, WHICH kind of nothing is it?
// The console design gives them the same vocabulary, so it is declared once here and both
// consume it, rather than each growing its own arm set that agrees until one of them
// grows a fifth.
//
// WHY THIS IS NOT `NothingKind`. Two of the arms below are not absences. `ready` says a
// body is mounted, and `refused` carries a daemon refusal, which has its own grammar — a
// code in mono and the daemon's message verbatim — rather than the prose-plus-glyph shape
// an absence takes. Mapping `refused` onto the `error` absence would lose the code, and
// mapping `ready` onto anything would be a category error. What this set DOES is decide
// which of those two grammars the state strip reaches for, and the mapping to
// `NothingKind` for the two arms that are absences lives in `WorkflowStateStrip.tsx`,
// where the rendering does.
//

import type { Refusal } from "@renderer/lib/refusal.js";

/**
 * Every state a workflows state strip can be in, in the order a surface moves through
 * them: the read is in flight, the read found none, the daemon refused, a body is
 * mounted.
 *
 * The tuple is the declaration and the union's discriminant is derived from it, for
 * `registries/screens/screen-registry.ts`'s reason: a union written beside a hand-repeated array
 * is two closed sets that agree until someone widens one, and the compiler sees
 * neither drift.
 */
export const WORKFLOW_STRIP_STATES = ["not-loaded", "empty", "refused", "ready"] as const;

/** One strip state's discriminant. Derived from the enumeration, never restated. */
export type WorkflowStripStateKind = (typeof WORKFLOW_STRIP_STATES)[number];

/**
 * What a workflows body is showing.
 *
 * Copy travels ON the state rather than being looked up from the kind, because the
 * surfaces are absent about different things — no runs, no phases, no definition to
 * author — and a shared lookup table would either say something vague enough to fit
 * all of them or grow a per-surface branch, which is the same table with extra steps.
 */
export type WorkflowStripState =
  | { readonly kind: "not-loaded"; readonly title: string }
  | { readonly kind: "empty"; readonly title: string }
  | { readonly kind: "refused"; readonly refusal: Refusal }
  | { readonly kind: "ready" };

/**
 * The state of a body the daemon refused.
 *
 * Takes the refusal whole rather than its two rendered fields, so the value that
 * arrives from a bridge call is the value that reaches the renderer — `origin`
 * included, which stays off the screen and is kept for the diagnostic band.
 */
export function refusedWorkflowStrip(refusal: Refusal): WorkflowStripState {
  return { kind: "refused", refusal };
}
