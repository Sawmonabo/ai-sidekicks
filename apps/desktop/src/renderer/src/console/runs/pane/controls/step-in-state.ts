// What a step-in has answered, and how that is read off the pane's own surface.
//
// A leaf beside the three modules that need it. `StepIn.tsx` dispatches the pause and
// reads this back; `StepInReceipt.tsx` renders it. Neither may import the other without
// closing a cycle, so the shape both read lives below both — the smallest module that
// makes the trio a DAG rather than a loop.
//
// IT IS DERIVED AND NOTHING IS STORED. The pause is dispatched through the pane's one
// `RunControlSurface`, which already holds the in-flight set and the settlement record
// for every control on every run — so a second copy of "this step-in is going" beside
// them would be a second answer to a question the surface already answers, and the two
// would disagree the first time a record was dropped by the outcome cap or a settlement
// arrived on a transport that had been replaced. What the control holds is the token
// its OWN dispatch was admitted under, and this reads the surface through it.

import type { RunControlAck } from "@ai-sidekicks/contracts";

import type { ConsoleRefusal } from "../../../core/index.js";
import { inFlightKeyFor, type RunControlSurface } from "./run-control-surface.js";

/**
 * Where one step-in has got to.
 *
 * `paused` carries the daemon's own acknowledgment rather than a boolean, because
 * the receipt is composed from what the daemon echoed — the post-transition state and
 * the advanced run version — and never from what the console hoped would happen.
 */
export type StepInState =
  | { readonly phase: "idle" }
  | { readonly phase: "pausing" }
  | { readonly phase: "paused"; readonly acknowledgment: RunControlAck }
  | { readonly phase: "refused"; readonly refusal: ConsoleRefusal };

const IDLE: StepInState = { phase: "idle" };
const PAUSING: StepInState = { phase: "pausing" };

/**
 * Read this control's step-in off the surface both entry points dispatch through.
 *
 * BUSY IS THE RUN'S AND THE RECEIPT IS THIS CONTROL'S. A pause in flight on this run
 * is a pause whoever pressed it — this button or the palette row contributed for the
 * same control — and the button must say so, because the shared latch will refuse a
 * second press and a control that looked idle while refusing is a control that appears
 * broken. What the RECEIPT names is narrower: the settlement of the request this
 * control made, found by the token its own dispatch was admitted under. Reading the
 * newest pause on the run instead would let this button report a transition the
 * palette asked for.
 *
 * A token with no record and no pause in flight reads as idle — the outcome cap has
 * dropped it — which is what the surface can still honestly say about it.
 */
export function readStepInState(
  surface: RunControlSurface,
  targetRunId: string,
  dispatchToken: string | undefined,
): StepInState {
  if (surface.inFlightKeys.has(inFlightKeyFor(targetRunId, "pause"))) {
    return PAUSING;
  }
  if (dispatchToken === undefined) {
    return IDLE;
  }
  const settled = surface.records.find((record) => record.recordId === dispatchToken);
  if (settled === undefined) {
    return IDLE;
  }
  if (settled.outcome.kind === "acknowledged") {
    return { phase: "paused", acknowledgment: settled.outcome.ack };
  }
  if (settled.outcome.kind === "refused") {
    return { phase: "refused", refusal: settled.outcome.refusal };
  }
  // `settled` is the INTERVENTION path's arm, and pause is a control verb that never
  // travels it — the token embeds the control it was admitted for, so a record of that
  // kind cannot carry a step-in's token. Reading it as idle rather than raising keeps
  // an impossible record off a person's screen instead of onto it.
  return IDLE;
}
