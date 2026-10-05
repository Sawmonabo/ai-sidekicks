// What the node-graph builder's body is showing, as one closed set. Not `NothingKind`: `ready` is
// not an empty state and `refused` carries a daemon refusal (code in mono, message verbatim), so
// the mapping to `NothingKind` for the two empty-state arms lives in `WorkflowStateStrip.tsx`,
// where the rendering does.

import type { Refusal } from "@renderer/lib/refusal/refusal.js";

/**
 * What the builder's body is showing, in the order it moves through the states: the read is in
 * flight, found none, the daemon refused, a body is mounted. Copy travels on the state, so the
 * caller names what is absent.
 */
export type WorkflowStripState =
  | { readonly kind: "not-loaded"; readonly title: string }
  | { readonly kind: "empty"; readonly title: string }
  | { readonly kind: "refused"; readonly refusal: Refusal }
  | { readonly kind: "ready" };

/**
 * The state of a body the daemon refused. Takes the refusal whole, `origin` included, which
 * stays off the screen and feeds the diagnostic band.
 */
export function refusedWorkflowStrip(refusal: Refusal): WorkflowStripState {
  return { kind: "refused", refusal };
}
