// The seam between a chord and the workflows screen. The screen's two keyed acts are contributed
// before the screen exists, so whatever offers an act adopts its holder while mounted and the
// command resolves its target at press time. The newest mounted control is the target. While no
// control offers the act, a fallback — the open run's page — takes the press: it opens the step
// that waits, and the press then goes to that step's control once it is offered, so a form still
// being read is answered when it is ready. Release is by identity, so a strict-mode double mount
// or a route change cannot leave a gone one adopted. Module scope is one window.

import { refuse, type Refusal } from "@renderer/lib/refusal.js";
import { raiseCommandRefusal } from "@renderer/registries/commands/command-refusal.js";
import type { Unsubscribe } from "@shared/preload-api.js";

/** One press of a keyed act: `undefined` where it acted, else why it could not. */
export type WorkflowCommandPress = () => Refusal | undefined;

/** What an adopter is to the act: a control that performs it, or the fallback behind them all. */
export type WorkflowCommandRole = "control" | "fallback";

/** One keyed act and the mounted controls that offer it, in mount order. */
export class WorkflowCommandTarget {
  readonly #notMounted: Refusal;
  readonly #reportLater: (refusal: Refusal) => void;
  readonly #adopted: Record<WorkflowCommandRole, WorkflowCommandPress[]> = {
    control: [],
    fallback: [],
  };
  // The fallback whose press opened a step and now waits for that step's control to be offered.
  #awaitingControl: WorkflowCommandPress | undefined;

  /**
   * `notMounted` is what a press says while nothing on screen offers the act; `reportLater` states
   * a refusal from a press that waited for its control, which has no caller left to answer.
   */
  public constructor(
    notMounted: Refusal,
    reportLater: (refusal: Refusal) => void = raiseCommandRefusal,
  ) {
    this.#notMounted = notMounted;
    this.#reportLater = reportLater;
  }

  /**
   * Become the act's target for a mount's lifetime, and take a press that was waiting for a
   * control. The return value releases exactly this one.
   */
  public adopt(press: WorkflowCommandPress, role: WorkflowCommandRole = "control"): Unsubscribe {
    const adopted = this.#adopted[role];
    adopted.push(press);
    if (role === "control" && this.#awaitingControl !== undefined) {
      this.#awaitingControl = undefined;
      const refusal = press();
      if (refusal !== undefined) {
        this.#reportLater(refusal);
      }
    }
    return () => {
      const position = adopted.lastIndexOf(press);
      if (position >= 0) {
        adopted.splice(position, 1);
      }
      if (this.#awaitingControl === press) {
        this.#awaitingControl = undefined;
      }
    };
  }

  /**
   * Press the act on its newest control, else on its newest fallback, which leaves the press
   * waiting for the control it opens, or answer why it could not be pressed.
   */
  public press(): Refusal | undefined {
    const control = this.#adopted.control.at(-1);
    if (control !== undefined) {
      return control();
    }
    const fallback = this.#adopted.fallback.at(-1);
    if (fallback === undefined) {
      return this.#notMounted;
    }
    const refusal = fallback();
    if (refusal === undefined) {
      this.#awaitingControl = fallback;
    }
    return refusal;
  }
}

/** `Next waiting`: what pressing `Next waiting (N)` on the Runs tab's strip does. */
export const nextWaitingTarget: WorkflowCommandTarget = new WorkflowCommandTarget(
  refuse("workflows", "workflows.not_open", "Workflows is not open. Open it and try again."),
);

/** `Answer this run`: the main answer the open run's blocking step offers, `Approve` for one. */
export const answerThisRunTarget: WorkflowCommandTarget = new WorkflowCommandTarget(
  refuse(
    "workflows",
    "workflows.no_answer_open",
    "No run waiting on you is open. Open one and try again.",
  ),
);
