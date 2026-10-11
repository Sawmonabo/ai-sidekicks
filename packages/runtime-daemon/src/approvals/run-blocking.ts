// How an ask holds its run: the run waits for approval from its first ask, and runs again once it
// holds no ask still open, so a second ask on a run already waiting changes nothing and an answer
// with another ask still open leaves the run waiting. The moves of one run are made one after the
// other, so an answer's check for asks still open never crosses a new ask's block. A run that ends
// cancels the asks it still holds.

import type { ApprovalRequestId } from "@ai-sidekicks/contracts/approval";
import type { RunId } from "@ai-sidekicks/contracts/run/id";

import type { RunEngine } from "../session/run/engine.js";
import { RunInvalidTransitionError } from "../session/run/refusals.js";
import type { RunSetupGate, RunTerminalContext } from "../session/run/setup-gates.js";
import type { ApprovalOutcomeListener, ApprovalService } from "./service.js";

/** What the run hold moves runs through and cancels asks with. */
export interface ApprovalRunBlockingDeps {
  readonly runEngine: Pick<RunEngine, "applyProviderStateChange">;
  readonly approvals: Pick<ApprovalService, "hasPendingForRun" | "cancelPendingForRun">;
  /** Lets go of what the intake held for the asks of a run that ended. */
  readonly forgetRun: (runId: RunId) => void;
}

/**
 * The approval service's outcome listener and the run engine's setup gate: parks a run on its asks,
 * resumes it once none is open, and cancels the asks of a run that ended.
 */
export class ApprovalRunBlocking implements ApprovalOutcomeListener, RunSetupGate {
  readonly #deps: ApprovalRunBlockingDeps;
  // Each run's moves in flight, chained so they are made in the order they were asked for.
  readonly #movesByRun = new Map<RunId, Promise<void>>();

  constructor(deps: ApprovalRunBlockingDeps) {
    this.#deps = deps;
  }

  /** Moves the run to wait for approval; a run already waiting, or not running, stays as it is. */
  async onBlocking(runId: RunId, _approvalRequestId: ApprovalRequestId): Promise<void> {
    await this.#inOrder(runId, async () => {
      await this.#move(runId, "waiting_for_approval");
    });
  }

  /** Runs the run again once it holds no ask still open. */
  async onSettled(runId: RunId, _approvalRequestId: ApprovalRequestId): Promise<void> {
    await this.#inOrder(runId, async () => {
      if (!this.#deps.approvals.hasPendingForRun(runId)) {
        await this.#move(runId, "running");
      }
    });
  }

  /** A run passes no approval check before it starts: its asks come while it runs. */
  async assertRunReady(): Promise<void> {}

  /** Cancels the asks the ended run still holds. */
  async onRunTerminal(context: RunTerminalContext): Promise<void> {
    this.#deps.forgetRun(context.runId);
    await this.#deps.approvals.cancelPendingForRun(context.runId);
  }

  // A move the run's state does not allow is no move: a run already waiting stays waiting, a run
  // that is pausing, paused or waiting on a question keeps that state with its ask open, and one
  // that resumed meanwhile or ended stays as it is.
  async #move(runId: RunId, newState: "waiting_for_approval" | "running"): Promise<void> {
    try {
      await this.#deps.runEngine.applyProviderStateChange(
        newState === "running"
          ? { runId, newState, expectedState: "waiting_for_approval" }
          : { runId, newState },
      );
    } catch (error) {
      if (!(error instanceof RunInvalidTransitionError)) {
        throw error;
      }
    }
  }

  async #inOrder(runId: RunId, move: () => Promise<void>): Promise<void> {
    const previous = this.#movesByRun.get(runId) ?? Promise.resolve();
    const next = previous.then(move);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.#movesByRun.set(runId, settled);
    try {
      await next;
    } finally {
      if (this.#movesByRun.get(runId) === settled) {
        this.#movesByRun.delete(runId);
      }
    }
  }
}
