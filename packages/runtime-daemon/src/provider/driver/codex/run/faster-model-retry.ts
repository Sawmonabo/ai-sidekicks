// Codex's faster-model retry: a turn Codex holds for a safety check is stopped, the conversation
// forked to just before it, and the same message sent again on the faster model, which stays the
// session's model. The run goes on in the new turn under its binding; nothing is drawn twice. An
// interrupt of the run while it retries goes out at once and stops the retry, which then forks and
// sends nothing more; the turn it stopped ends as the interrupt's would. An interrupt that comes
// once the fork has begun leaves the session on the fork, the conversation the retry moved it to,
// since the one it left is already let go.

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
  readonly turnEnds: Pick<CodexTurnEndWaiters, "waitForEnd" | "settle">;
  readonly dispatch: CodexDeliveryDispatch;
}

// One retry in flight: its session, the conversation its held turn ran on, the answer to its
// interrupt, whether it has begun to fork, and its end.
interface CodexRetryInFlight {
  readonly record: CodexSessionRecord;
  readonly heldThreadId: string;
  readonly interruptAnswered: Promise<void>;
  readonly settled: Promise<void>;
  isForking: boolean;
  isCanceled: boolean;
}

/** A retry an interrupt stopped: its session, and the conversation its held turn ran on. */
export interface CodexStoppedRetry {
  readonly record: CodexSessionRecord;
  readonly heldThreadId: string;
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
    const settled = Promise.withResolvers<void>();
    const inFlight: CodexRetryInFlight = {
      record,
      heldThreadId: record.threadId,
      interruptAnswered: interrupting.then(
        () => undefined,
        () => undefined,
      ),
      settled: settled.promise,
      isForking: false,
      isCanceled: false,
    };
    this.#inFlightByRun.set(params.runId, inFlight);
    try {
      return await this.#retry(params, inFlight, interrupting, input, binding);
    } finally {
      this.#inFlightByRun.delete(params.runId);
      settled.resolve();
    }
  }

  /**
   * Stops the retry of `runId` in flight, answering the session's record and the conversation its
   * held turn ran on when that stopped the run: the retry forks and sends nothing more, and lets
   * the run's binding go once its stopped turn has ended. A retry that has begun to fork is waited
   * for, so the session is on its one conversation when this answers. Answers `undefined` with no
   * retry in flight, and once a turn the retry kept or already sent runs as the run's, which the
   * interrupt then stops as any live turn.
   */
  async cancel(runId: RunId): Promise<CodexStoppedRetry | undefined> {
    const inFlight = this.#inFlightByRun.get(runId);
    if (inFlight === undefined) {
      return undefined;
    }
    inFlight.isCanceled = true;
    const { record } = inFlight;
    // An interrupt Codex refused leaves the held turn running as the run's; a turn already sent
    // is the run's once Codex answers it.
    await inFlight.interruptAnswered;
    if (inFlight.isForking) {
      await inFlight.settled;
    }
    return newestActiveTurnForRun(record, runId) === undefined
      ? { record, heldThreadId: inFlight.heldThreadId }
      : undefined;
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
        // The turn is the run's live one again, no turn the daemon is stopping.
        turnEnds.settle();
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
      // resume after a restart finds the fork, never the held turn. A fork that fails leaves the
      // session on its conversation and its model.
      inFlight.isForking = true;
      const heldSettings = record.threadSettings;
      const fasterSettings = {
        ...heldSettings,
        model: params.model,
        modelContextWindow: undefined,
      };
      record.threadSettings = fasterSettings;
      try {
        await slots.claim(
          params.sessionId,
          "establishing",
          async () => await forks.establishFork(record, turnId, binding.bindingId),
        );
      } catch (cause) {
        if (record.threadSettings === fasterSettings) {
          record.threadSettings = heldSettings;
        }
        throw cause;
      }
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
