// What a step-in has answered, and the name it refuses under.
//
// A leaf beside the two modules that need it. `StepIn.tsx` performs the pause and
// advances this state; `StepInReceipt.tsx` renders it. Neither may import the other
// without closing a cycle, so the shape both read lives below both — the smallest
// module that makes the pair a DAG rather than a loop.

import type { RunControlAck } from "@ai-sidekicks/contracts";

import type { ConsoleRefusal } from "../../../core/index.js";

/** The subsystem name every refusal the step-in control raises carries. */
export const STEP_IN_REFUSAL_ORIGIN = "composer-step-in";

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
