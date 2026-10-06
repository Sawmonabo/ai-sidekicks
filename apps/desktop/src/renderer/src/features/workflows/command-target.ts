// The seam between a chord and the workflows screen. The screen's two keyed acts are contributed
// before the screen exists, so whatever offers an act adopts its holder while mounted and the
// command resolves its target when it is listed or pressed. The newest mounted control is the
// target. While no control offers the act, a fallback — the open run's page — takes the press: it
// opens the step that waits, and the press then goes to that step's control once it is offered,
// so a form still being read is answered when it is ready. An act that cannot be taken says why
// and a press of it does nothing. Release is by identity, so a strict-mode double mount or a route
// change cannot leave a gone one adopted. The targets are built once per composition, so one
// serves every window: each adopter names the document it is drawn in and a press reaches only
// its own window's.

import { createContext, type Context } from "react";

import type { Unsubscribe } from "#shared/preload-api.js";

/** What an adopter offers of a keyed act: why it cannot be taken now, and taking it. */
export interface WorkflowCommandOffer {
  /** Why the act cannot be taken right now, in the screen's words; `undefined` where it can. */
  readonly unavailable: () => string | undefined;
  /** Take the act; pressed only while `unavailable` answers `undefined`. */
  readonly take: () => void;
}

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
  readonly #notMounted: string;
  readonly #adopted: Record<WorkflowCommandRole, AdoptedOffer[]> = {
    control: [],
    fallback: [],
  };
  // The fallback whose press opened a step and now waits for that step's control to be offered.
  #awaitingControl: AdoptedOffer | undefined;

  /** `notMounted` is why the act cannot be taken while nothing on screen offers it. */
  public constructor(notMounted: string) {
    this.#notMounted = notMounted;
  }

  /**
   * Become the act's target in the window `ownerDocument` belongs to, for a mount's lifetime, and
   * take a press in that window that was waiting for a control, where the control can take it.
   * The return value releases exactly this one.
   */
  public adopt(
    offer: WorkflowCommandOffer,
    ownerDocument: Document,
    role: WorkflowCommandRole = "control",
  ): Unsubscribe {
    const adopter: AdoptedOffer = { offer, ownerDocument };
    const adopted = this.#adopted[role];
    adopted.push(adopter);
    if (role === "control" && this.#awaitingControl?.ownerDocument === ownerDocument) {
      this.#awaitingControl = undefined;
      if (offer.unavailable() === undefined) {
        offer.take();
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
   * Why the act cannot be taken in the window `windowDocument` belongs to, read from the adopter a
   * press there would reach; `undefined` where it can be taken.
   */
  public unavailable(windowDocument: Document | undefined): string | undefined {
    const adopter = this.#reached(windowDocument);
    return adopter === undefined ? this.#notMounted : adopter.offer.unavailable();
  }

  /**
   * Take the act on the newest control in the window `windowDocument` belongs to, else on its
   * newest fallback there, which leaves the press waiting for the control it opens. Where the act
   * cannot be taken it does nothing. An adopter in another window never takes the press.
   */
  public press(windowDocument: Document | undefined): void {
    const adopter = this.#reached(windowDocument);
    if (adopter === undefined || adopter.offer.unavailable() !== undefined) {
      return;
    }
    adopter.offer.take();
    if (this.#adopted.fallback.includes(adopter)) {
      this.#awaitingControl = adopter;
    }
  }

  #reached(windowDocument: Document | undefined): AdoptedOffer | undefined {
    const inWindow = (adopter: AdoptedOffer): boolean => adopter.ownerDocument === windowDocument;
    return this.#adopted.control.findLast(inWindow) ?? this.#adopted.fallback.findLast(inWindow);
  }
}

/**
 * The two acts, built once per composition and handed to both the commands that press them and
 * the screen that offers them.
 */
export function createWorkflowCommandTargets(): WorkflowCommandTargets {
  return {
    nextWaiting: new WorkflowCommandTarget("Workflows is not open."),
    answerThisRun: new WorkflowCommandTarget("No run waiting on you is open."),
  };
}

/** One adopter's offer and the document of the window it is drawn in. */
interface AdoptedOffer {
  readonly offer: WorkflowCommandOffer;
  readonly ownerDocument: Document;
}

/** The acts the screen's controls offer, provided by the screen to everything it draws. */
export const WorkflowCommandTargetsContext: Context<WorkflowCommandTargets | undefined> =
  createContext<WorkflowCommandTargets | undefined>(undefined);
