// What a step-in has answered, and the name it refuses under.
//
// A leaf beside the two modules that need it. `StepIn.tsx` performs the pause and
// advances this state; `StepInReceipt.tsx` renders it. Neither may import the other
// without closing a cycle, so the shape both read lives below both — the smallest
// module that makes the pair a DAG rather than a loop.

import type { RunControlAck } from "@ai-sidekicks/contracts";

import type { ConsoleRefusal } from "../../../core/index.js";
import type { TakeTheFloorOutcome } from "../../../seats/index.js";

/** The subsystem name every refusal the step-in control raises carries. */
export const STEP_IN_REFUSAL_ORIGIN = "composer-step-in";

/**
 * Where one step-in has got to.
 *
 * `paused` carries the daemon's own acknowledgment rather than a boolean, because
 * the receipt is composed from what the daemon echoed — the post-transition state and
 * the advanced run version — and never from what the console hoped would happen.
 *
 * AND IT CARRIES THE FLOOR SEPARATELY, because the pause and the two deck acts settle
 * at different moments: the pause is one call, and putting the run's checkout on the
 * deck needs the execution-root read. `undefined` is the interval between them — the
 * run is paused and the deck has not answered yet — so the receipt can say what has
 * happened without claiming what has not.
 */
export type StepInState =
  | { readonly phase: "idle" }
  | { readonly phase: "pausing" }
  | {
      readonly phase: "paused";
      readonly acknowledgment: RunControlAck;
      readonly floor: TakeTheFloorOutcome | undefined;
    }
  | { readonly phase: "refused"; readonly refusal: ConsoleRefusal };
