// The seam between a chord and the workflows screen. The screen's two keyed acts are contributed
// before the screen exists, so whatever offers an act adopts its holder while mounted and the
// command resolves its target at press time. The newest mounted control is the target. While no
// control offers the act, a fallback — the open run's page — takes the press: it opens the step
// that waits, and the press then goes to that step's control once it is offered, so a form still
// being read is answered when it is ready. Release is by identity, so a strict-mode double mount
// or a route change cannot leave a gone one adopted. The targets are built once per composition,
// so one serves every window: each adopter names the document it is drawn in and a press reaches
// only its own window's.

import { createContext, type Context } from "react";

import { refuse, type Refusal } from "#renderer/lib/refusal/contract.js";
import { raiseCommandRefusal } from "#renderer/registries/commands/refusal.js";
import type { Unsubscribe } from "#shared/preload-api.js";

/** One press of a keyed act: `undefined` where it acted, else why it could not. */
export type WorkflowCommandPress = () => Refusal | undefined;

/** What an adopter is to the act: a control that performs it, or the fallback behind them all. */
export type WorkflowCommandRole = "control" | "fallback";

/**
 * The screen's two keyed acts: `nextWaiting`, what pressing `Next waiting (N)` on the Runs tab's
 * strip does, and `answerThisRun`, the main answer the open run's blocking step offers, `Approve`
 * for one.
 */
export interface WorkflowCommandTargets {
  readonly nextWaiting: WorkflowCommandTarget;
  readonly answerThisRun: WorkflowCommandTarget;
}

/** One keyed act and the mounted controls that offer it, in mount order. */
export class WorkflowCommandTarget {
  readonly #notMounted: Refusal;
  readonly #reportLater: (refusal: Refusal) => void;
  readonly #adopted: Record<WorkflowCommandRole, AdoptedPress[]> = {
    control: [],
    fallback: [],
  };
  // The fallback whose press opened a step and now waits for that step's control to be offered.
  #awaitingControl: AdoptedPress | undefined;

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
   * Become the act's target in the window `ownerDocument` belongs to, for a mount's lifetime, and
   * take a press in that window that was waiting for a control. The return value releases exactly
   * this one.
   */
  public adopt(
    press: WorkflowCommandPress,
    ownerDocument: Document,
    role: WorkflowCommandRole = "control",
  ): Unsubscribe {
    const adopter: AdoptedPress = { press, ownerDocument };
    const adopted = this.#adopted[role];
    adopted.push(adopter);
    if (role === "control" && this.#awaitingControl?.ownerDocument === ownerDocument) {
      this.#awaitingControl = undefined;
      const refusal = press();
      if (refusal !== undefined) {
        this.#reportLater(refusal);
      }
    }
    return () => {
      const position = adopted.lastIndexOf(adopter);
      if (position >= 0) {
        adopted.splice(position, 1);
      }
      if (this.#awaitingControl === adopter) {
        this.#awaitingControl = undefined;
      }
    };
  }

  /**
   * Press the act on the newest control in the window `windowDocument` belongs to, else on its
   * newest fallback there, which leaves the press waiting for the control it opens, or answer why
   * it could not be pressed. An adopter in another window never takes the press.
   */
  public press(windowDocument: Document | undefined): Refusal | undefined {
    const inWindow = (adopter: AdoptedPress): boolean => adopter.ownerDocument === windowDocument;
    const control = this.#adopted.control.findLast(inWindow);
    if (control !== undefined) {
      return control.press();
    }
    const fallback = this.#adopted.fallback.findLast(inWindow);
    if (fallback === undefined) {
      return this.#notMounted;
    }
    const refusal = fallback.press();
    if (refusal === undefined) {
      this.#awaitingControl = fallback;
    }
    return refusal;
  }
}

/**
 * The two acts, built once per composition and handed to both the commands that press them and
 * the screen that offers them.
 */
export function createWorkflowCommandTargets(): WorkflowCommandTargets {
  return {
    nextWaiting: new WorkflowCommandTarget(
      refuse("workflows", "workflows.not_open", "Workflows is not open. Open it and try again."),
    ),
    answerThisRun: new WorkflowCommandTarget(
      refuse(
        "workflows",
        "workflows.no_answer_open",
        "No run waiting on you is open. Open one and try again.",
      ),
    ),
  };
}

/** One adopter's press and the document of the window it is drawn in. */
interface AdoptedPress {
  readonly press: WorkflowCommandPress;
  readonly ownerDocument: Document;
}

/** The acts the screen's controls offer, provided by the screen to everything it draws. */
export const WorkflowCommandTargetsContext: Context<WorkflowCommandTargets | undefined> =
  createContext<WorkflowCommandTargets | undefined>(undefined);
