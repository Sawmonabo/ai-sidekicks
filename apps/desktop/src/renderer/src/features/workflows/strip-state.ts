// What a workflows body is showing, as one closed set shared by the run view and the node-graph
// builder. Not `NothingKind`: `ready` is not an absence and `refused` carries a daemon refusal
// (code in mono, message verbatim), so the mapping to `NothingKind` for the two absence arms
// lives in `WorkflowStateStrip.tsx`, where the rendering does.

import type { Refusal } from "@renderer/lib/refusal.js";

/**
 * What a workflows body is showing, in the order a body moves through the states: the read is in
 * flight, found none, the daemon refused, a body is mounted. Copy travels on the state rather
 * than a shared lookup, because the bodies are absent about different things (no runs, no
 * phases, no definition).
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
