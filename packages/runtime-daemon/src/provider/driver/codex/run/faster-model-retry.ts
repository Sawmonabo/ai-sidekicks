// Codex's faster-model retry: a turn Codex holds for a safety check is stopped, the conversation
// forked to just before it, and the same message sent again on the faster model, which stays the
// session's model. The run goes on in the new turn under its binding; nothing is drawn twice. An
// interrupt of the run while it retries goes out at once and stops the retry, which then forks and
// sends nothing more; the turn it stopped ends as the interrupt's would.

import type { RunId } from "@ai-sidekicks/contracts/run/id";

import type { CodexDeliveryDispatch } from "../delivery/dispatch.js";
import { CodexTransportError, normalizeProviderFailureDetail } from "../session/errors.js";
import type { CodexConversationForks } from "../session/fork.js";
import type { CodexSessionSlots } from "../session/slots.js";
import {
  type CodexSessionRecord,
  type CodexTurnInput,
  newestActiveTurnForRun,
} from "../session/state.js";
import type { FasterModelRetryOutcome, FasterModelRetryParams } from "../../run-control.js";
import type { CodexRunBinding, CodexRunRoutes } from "./routes.js";
import type { CodexRunStart } from "./start.js";
import type { CodexTurnEndWaiters } from "./turn-end-waiters.js";

const INTERRUPTED_REJECTION: FasterModelRetryOutcome = {
  state: "rejected",
  rejectionReason: "The run was interrupted.",
};

/** What the retry acts through. */
export interface CodexFasterModelRetryDependencies {
  readonly slots: CodexSessionSlots;
  readonly runRoutes: CodexRunRoutes;
  readonly runStart: Pick<CodexRunStart, "startTurn">;
  readonly forks: Pick<CodexConversationForks, "establishFork">;
  readonly turnEnds: Pick<CodexTurnEndWaiters, "waitForEnd">;
  readonly dispatch: CodexDeliveryDispatch;
}

// One retry in flight: its session, the answer to its interrupt, and its end.
interface CodexRetryInFlight {
  readonly record: CodexSessionRecord;
  readonly interruptAnswered: Promise<void>;
  readonly settled: Promise<unknown>;
  isCanceled: boolean;
}

/** Retries held turns on a faster model, and stops a retry its run's interrupt reaches. */
export class CodexFasterModelRetries {
  readonly #dependencies: CodexFasterModelRetryDependencies;
  readonly #inFlightByRun = new Map<RunId, CodexRetryInFlight>();

  constructor(dependencies: CodexFasterModelRetryDependencies) {
    this.#dependencies = dependencies;
  }

  /**
   * Retries a held turn on a faster model. Answers `rejected` when the turn is no longer the run's
   * latest or its reply has started, and when an interrupt of the run stopped the retry. An
   * interrupt that fails while the turn runs on leaves the turn the run's and throws; any later
   * failure ends the run failed. Both throw `Failed to retry with a faster model: <reason>`.
   */
  async retry(params: FasterModelRetryParams): Promise<FasterModelRetryOutcome> {
    const { slots, runRoutes } = this.#dependencies;
    const record = slots.require(params.sessionId);
    const turnId = params.expectedTurnId;
    const input = record.turnInputByTurnId.get(turnId);
    const binding = runRoutes.bindingFor(params.runId);
    if (
      newestActiveTurnForRun(record, params.runId) !== turnId ||
      input === undefined ||
      binding === undefined
    ) {
      return { state: "rejected", rejectionReason: "The turn is no longer the run's latest." };
    }
    if (record.delivery.replyStartedTurnIds.has(turnId)) {
      return { state: "rejected", rejectionReason: "The turn's reply has started." };
    }
    // The stopped turn's end is the retry's, so it ends no run and keeps the run's binding. Marked
    // before the interrupt goes out, since the turn's end can follow its answer at once.
    record.delivery.retriedRunIdByTurnId.set(turnId, params.runId);
    runRoutes.retireTurnRoute(record, turnId);
    const interrupting = record.service.request("turn/interrupt", {
      threadId: record.threadId,
      turnId,
    });
    const settled = Promise.withResolvers<unknown>();
    const inFlight: CodexRetryInFlight = {
      record,
      interruptAnswered: interrupting.then(
        () => undefined,
        () => undefined,
      ),
      settled: settled.promise,
      isCanceled: false,
    };
    this.#inFlightByRun.set(params.runId, inFlight);
    try {
      return await this.#retry(params, inFlight, interrupting, input, binding);
    } finally {
      this.#inFlightByRun.delete(params.runId);
      settled.resolve(undefined);
    }
  }

  /**
   * Stops the retry of `runId` in flight, answering `true` when that stopped the run: the retry
   * forks and sends nothing more, and lets the run's binding go once its stopped turn has ended.
   * Answers `false` with no retry in flight, and once a turn the retry kept or already sent runs as
   * the run's, which the interrupt then stops as any live turn.
   */
  async cancel(runId: RunId): Promise<boolean> {
    const inFlight = this.#inFlightByRun.get(runId);
    if (inFlight === undefined) {
      return false;
    }
    inFlight.isCanceled = true;
    const { record } = inFlight;
    // An interrupt Codex refused leaves the held turn running as the run's; a turn already sent
    // is the run's once Codex answers it.
    await inFlight.interruptAnswered;
    if (record.delivery.startingTurnRunIds.includes(runId)) {
      await inFlight.settled;
    }
    return newestActiveTurnForRun(record, runId) === undefined;
  }

  async #retry(
    params: FasterModelRetryParams,
    inFlight: CodexRetryInFlight,
    interrupting: Promise<unknown>,
    input: CodexTurnInput,
    binding: CodexRunBinding,
  ): Promise<FasterModelRetryOutcome> {
    const { slots, runRoutes, runStart, forks, turnEnds, dispatch } = this.#dependencies;
    const { record } = inFlight;
    const turnId = params.expectedTurnId;
    try {
      await interrupting;
    } catch (cause) {
      if (!record.settledTurnIds.has(turnId)) {
        // Not stopped: the turn runs on as the run's, so the retry is refused and the run is not.
        record.delivery.retriedRunIdByTurnId.delete(turnId);
        record.runIdByActiveTurnId.set(turnId, params.runId);
        runRoutes.bindRun(params.runId, params.sessionId, turnId);
        throw new Error(
          `Failed to retry with a faster model: ${normalizeProviderFailureDetail(cause)}`,
          { cause },
        );
      }
    }
    try {
      const hasEnded = await turnEnds.waitForEnd(record, turnId);
      if (inFlight.isCanceled) {
        this.#forgetStoppedRun(params.runId, binding);
        return INTERRUPTED_REJECTION;
      }
      if (!hasEnded) {
        throw new CodexTransportError("The held turn did not stop.", {
          sessionId: params.sessionId,
          turnId,
        });
      }
      // The fork carries the faster model on its default window, and every later start and resume
      // carries it too. The run's own binding is pointed at the fork before the turn is sent, so a
      // resume after a restart finds the fork, never the held turn.
      record.threadSettings = {
        ...record.threadSettings,
        model: params.model,
        modelContextWindow: undefined,
      };
      await slots.claim(
        params.sessionId,
        "establishing",
        async () => await forks.establishFork(record, turnId, binding.bindingId),
      );
      // An interrupt from here on withdraws the turn before it is sent.
      await runStart.startTurn(record, {
        runId: params.runId,
        messages: input.messages,
        clientMessageIds: input.clientMessageIds,
        model: params.model,
        modelContextWindow: undefined,
        outputSpeed: undefined,
        outputSpeedForTurn: input.outputSpeedForTurn,
        outputSchema: undefined,
        level: undefined,
        isWithdrawn: () => inFlight.isCanceled,
      });
    } catch (cause) {
      if (inFlight.isCanceled) {
        this.#forgetStoppedRun(params.runId, binding);
        return INTERRUPTED_REJECTION;
      }
      const reason = normalizeProviderFailureDetail(cause);
      void dispatch.send(
        params.sessionId,
        {
          kind: "run_lifecycle",
          bindingId: binding.bindingId,
          change: {
            runId: params.runId,
            newState: "failed",
            failureCategory: "provider failure",
            providerFailureDetail: `Failed to retry with a faster model: ${reason}`,
          },
        },
        null,
      );
      runRoutes.forgetRun(params.runId);
      throw new Error(`Failed to retry with a faster model: ${reason}`, { cause });
    }
    return { state: "applied" };
  }

  // The end of a turn the retry stopped forgets no run, so the binding of a run the interrupt
  // stopped goes here, unless a continue of the run bound it again meanwhile.
  #forgetStoppedRun(runId: RunId, binding: CodexRunBinding): void {
    if (this.#dependencies.runRoutes.bindingFor(runId) === binding) {
      this.#dependencies.runRoutes.forgetRun(runId);
    }
  }
}
