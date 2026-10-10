// Acting on a running Codex turn: interrupting it, steering it, and pausing and continuing its
// run. A steer is never held for a step's end: it goes out once Codex answered the steer before it.
// A pause holds the run's next tool call at the daemon's pre-tool hook, the lead's or a helper's;
// on the person's own Codex, which runs no daemon hook, a lead's pause is an interrupt at the
// step's end.

import type { InterruptRunParams } from "@ai-sidekicks/contracts/provider/driver/intervention";
import type { RunId } from "@ai-sidekicks/contracts/run/id";

import { isPlainObject } from "../../../record-readers.js";
import type { PauseRunParams, ResumeRunParams, WaitingMessage } from "../../run-control.js";
import { DriverCapabilityUnsupportedError } from "../../registry.js";
import { CODEX_DRIVER_NAME } from "../capabilities.js";
import type { CodexDeliveryDispatch } from "../delivery/dispatch.js";
import type { CodexHookPause, CodexRunPauses } from "../hooks/pause.js";
import type { CodexSteerAcknowledgement, CodexSteerRunRequest } from "../intervention.js";
import { endCodexRunningCommands } from "../session/background-terminals.js";
import { CodexTransportError, normalizeProviderFailureDetail } from "../session/errors.js";
import type { CodexConfigForks } from "../session/config-fork.js";
import type { CodexSessionSlots } from "../session/slots.js";
import {
  type CodexLifecycleOptions,
  type CodexSessionRecord,
  newestActiveTurnForRun,
  rememberInterruptedRun,
} from "../session/state.js";
import { steerActiveTurn } from "../steer.js";
import { reportDiagnosticFromDetachedFrame } from "../transport/diagnostics.js";
import type { CodexRunRoutes } from "./routes.js";
import type { CodexRunStart } from "./start.js";

/** What run control needs from the lifecycle. */
export interface CodexRunControlDependencies {
  readonly options: Pick<CodexLifecycleOptions, "reportDiagnostic" | "onLostRunFailure">;
  readonly slots: CodexSessionSlots;
  readonly configForks: Pick<CodexConfigForks, "requireAfterForks">;
  readonly runRoutes: CodexRunRoutes;
  readonly runStart: CodexRunStart;
  readonly pauses: CodexRunPauses;
  readonly dispatch: CodexDeliveryDispatch;
}

// A helper's waiting messages, as one block of the person's words it reads after its next call.
function composeHelperWords(messages: readonly WaitingMessage[]): string | undefined {
  return messages.length === 0
    ? undefined
    : messages.map((message) => message.content).join("\n\n");
}

/** Interrupts, steers, pauses and continues runs on their live turns. */
export class CodexRunControl {
  readonly #options: CodexRunControlDependencies["options"];
  readonly #slots: CodexSessionSlots;
  readonly #configForks: CodexRunControlDependencies["configForks"];
  readonly #runRoutes: CodexRunRoutes;
  readonly #runStart: CodexRunStart;
  readonly #pauses: CodexRunPauses;
  readonly #dispatch: CodexDeliveryDispatch;

  constructor(dependencies: CodexRunControlDependencies) {
    this.#options = dependencies.options;
    this.#slots = dependencies.slots;
    this.#configForks = dependencies.configForks;
    this.#runRoutes = dependencies.runRoutes;
    this.#runStart = dependencies.runStart;
    this.#pauses = dependencies.pauses;
    this.#dispatch = dependencies.dispatch;
  }

  /**
   * Interrupts the run's live turn and retires its route, so a later steer or second interrupt
   * is refused, then ends the commands it left running, which an interrupt does not stop. The
   * turn's correlation is kept for the `turn/completed` that follows.
   */
  async interruptRun(params: InterruptRunParams): Promise<void> {
    const { record, turnId } = this.#slots.requireActiveTurn(params.runId);
    await record.service.request("turn/interrupt", { threadId: record.threadId, turnId });
    record.pauseRunIdByTurnId.delete(turnId);
    this.#dropHookPause(params.runId);
    if (!(await this.#rememberInterrupted(record, turnId, params.runId))) {
      return;
    }
    this.#runRoutes.retireTurnRoute(record, turnId);
    await endCodexRunningCommands(record.service, record.threadId, this.#options.reportDiagnostic, {
      clean: false,
    });
  }

  /**
   * Sends a steer into the run's live turn as soon as it is handed over, once Codex answered the
   * conversation's steer before it, and answers once Codex took it; each carries its own key,
   * which Codex echoes on that message. Rejects when the send failed.
   */
  async steerRun(request: CodexSteerRunRequest): Promise<CodexSteerAcknowledgement> {
    const { record, turnId } = this.#slots.requireActiveTurn(request.runId);
    return await steerActiveTurn(record, turnId, request);
  }

  /**
   * Pauses the lead run or a helper's child run from its next tool call on. Resolves at once: the
   * pause is reported when it takes effect. Throws `CodexTransportError` for a run with no live
   * turn here, and for a helper's run on a service that runs no daemon hook.
   */
  pauseRun(params: PauseRunParams): void {
    const record = this.#slots.require(params.sessionId);
    const binding = this.#runRoutes.bindingFor(params.runId);
    const childThreadId = record.delivery.childThreadIdByRunId.get(params.runId);
    const child =
      childThreadId === undefined
        ? undefined
        : record.delivery.childRunByThreadId.get(childThreadId);
    if (childThreadId !== undefined && child !== undefined && record.service.runsDaemonHooks) {
      this.#pauses.pause(childThreadId, {
        sessionId: params.sessionId,
        runId: params.runId,
        bindingId: child.bindingId,
      });
      return;
    }
    const turnId = newestActiveTurnForRun(record, params.runId);
    if (turnId === undefined || binding === undefined) {
      throw new CodexTransportError(
        `Run "${params.runId}" has no live Codex turn on session "${params.sessionId}" that a ` +
          `pause can stop; a helper's run pauses only through the daemon's pre-tool hook.`,
        { sessionId: params.sessionId, runId: params.runId },
      );
    }
    if (record.service.runsDaemonHooks) {
      this.#pauses.pause(record.threadId, {
        sessionId: params.sessionId,
        runId: params.runId,
        bindingId: binding.bindingId,
      });
      return;
    }
    record.pauseRunIdByTurnId.set(turnId, params.runId);
  }

  /**
   * Continues a run with the messages that waited for it. A hook pause lets its held calls run:
   * the lead's messages are steered into its turn, a helper's reach it after its next call. Without
   * hooks, a pause not yet taken effect is dropped and the messages steered into the turn still
   * running; one whose interrupt is on its way continues when that turn ends; a paused run starts
   * its next turn with them. Throws `DriverCapabilityUnsupportedError` for a message carrying
   * attachments, before anything is sent.
   */
  async resumeRun(params: ResumeRunParams): Promise<void> {
    if (params.messages.some((message) => (message.attachments ?? []).length > 0)) {
      throw new DriverCapabilityUnsupportedError(CODEX_DRIVER_NAME, "steer");
    }
    const record = await this.#configForks.requireAfterForks(params.sessionId);
    const pausedThreadId = this.#pauses.threadPausedFor(params.runId);
    if (pausedThreadId !== undefined && pausedThreadId !== record.threadId) {
      this.#pauses.resume(pausedThreadId, composeHelperWords(params.messages));
      return;
    }
    if (pausedThreadId !== undefined) {
      const turnId = newestActiveTurnForRun(record, params.runId);
      try {
        if (turnId !== undefined) {
          await this.#steerWaiting(record, turnId, params);
        } else if (params.messages.length > 0) {
          await this.#continue(record, params);
        }
      } finally {
        this.#pauses.resume(pausedThreadId, undefined);
      }
      return;
    }
    for (const [turnId, runId] of record.pauseRunIdByTurnId) {
      if (runId === params.runId) {
        record.pauseRunIdByTurnId.delete(turnId);
        await this.#steerWaiting(record, turnId, params);
        return;
      }
    }
    if ([...record.pausedRunIdByInterruptedTurnId.values()].includes(params.runId)) {
      record.continuesAwaitingPause.set(params.runId, params);
      return;
    }
    await this.#continue(record, params);
  }

  /** Delivers a run's `paused` once its pause took effect; a refusal is recorded. */
  deliverPaused(pause: CodexHookPause): void {
    void this.#dispatch.send(
      pause.sessionId,
      {
        kind: "run_lifecycle",
        bindingId: pause.bindingId,
        change: { runId: pause.runId, expectedState: "pausing", newState: "paused" },
      },
      null,
    );
  }

  /**
   * Acts on the end of a step: a pause waiting for this boundary interrupts the turn. Never
   * throws; what fails is reported.
   */
  async observeItemCompleted(record: CodexSessionRecord, params: unknown): Promise<void> {
    const turnId = isPlainObject(params) ? params["turnId"] : undefined;
    if (typeof turnId !== "string") {
      return;
    }
    const pausedRunId = record.pauseRunIdByTurnId.get(turnId);
    if (pausedRunId === undefined) {
      return;
    }
    record.pauseRunIdByTurnId.delete(turnId);
    // Marked before the interrupt goes out, so a continue meanwhile waits for the turn's end.
    record.pausedRunIdByInterruptedTurnId.set(turnId, pausedRunId);
    try {
      await record.service.request("turn/interrupt", { threadId: record.threadId, turnId });
    } catch (cause) {
      record.pausedRunIdByInterruptedTurnId.delete(turnId);
      reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
        kind: "pause-interrupt-failed",
        threadId: record.threadId,
        detail: normalizeProviderFailureDetail(cause),
      });
      // The turn runs on, so a continue that waited for it steers its messages in instead.
      const awaitingContinue = record.continuesAwaitingPause.get(pausedRunId);
      if (awaitingContinue !== undefined) {
        record.continuesAwaitingPause.delete(pausedRunId);
        try {
          await this.#steerWaiting(record, turnId, awaitingContinue);
        } catch (steerFailure) {
          this.#reportSteerUndelivered(record, steerFailure);
        }
      }
      return;
    }
    this.#runRoutes.retireTurnRoute(record, turnId);
  }

  /**
   * Acts on a turn's end: a pause's interrupted turn reports the pause, or starts the continue
   * asked for meanwhile; a pause waiting for a step that never came is dropped.
   * Never throws: a continue that cannot start fails its run, which no turn would end.
   */
  async observeTurnEnded(
    record: CodexSessionRecord,
    turnId: string,
    endedRunId: RunId | undefined,
  ): Promise<void> {
    record.pauseRunIdByTurnId.delete(turnId);
    // A lead whose turn ended before any call was held has nothing left to pause.
    if (endedRunId !== undefined && newestActiveTurnForRun(record, endedRunId) === undefined) {
      this.#dropHookPause(endedRunId);
    }
    const pausedRunId = record.pausedRunIdByInterruptedTurnId.get(turnId);
    if (pausedRunId === undefined) {
      return;
    }
    record.pausedRunIdByInterruptedTurnId.delete(turnId);
    const awaitingContinue = record.continuesAwaitingPause.get(pausedRunId);
    if (awaitingContinue !== undefined) {
      record.continuesAwaitingPause.delete(pausedRunId);
      try {
        await this.#continue(record, awaitingContinue);
      } catch (cause) {
        this.#options.onLostRunFailure(record.sessionId, pausedRunId, {
          eventType: "run.failed",
          failureCategory: "provider failure",
          recoveryCondition: "recovery-needed",
          providerFailureDetail: normalizeProviderFailureDetail(cause),
        });
      }
      return;
    }
    const bindingId = this.#runRoutes.bindingIdFor(pausedRunId);
    if (bindingId !== undefined) {
      this.deliverPaused({ sessionId: record.sessionId, runId: pausedRunId, bindingId });
    }
  }

  /** Steers a run's waiting messages, in send order, into its turn still running. */
  async #steerWaiting(
    record: CodexSessionRecord,
    turnId: string,
    params: ResumeRunParams,
  ): Promise<void> {
    for (const message of params.messages) {
      await steerActiveTurn(record, turnId, {
        runId: params.runId,
        content: message.content,
        clientIdempotencyKey: message.id,
      });
    }
  }

  /** Starts a paused run's next turn with the messages that waited for it. */
  async #continue(record: CodexSessionRecord, params: ResumeRunParams): Promise<void> {
    await this.#runStart.startTurn(record, {
      runId: params.runId,
      texts: params.messages.map((message) => message.content),
      clientMessageIds: params.messages.map((message) => message.id),
      model: undefined,
      modelContextWindow: record.threadSettings.modelContextWindow,
      outputSpeed: undefined,
      // The person's level for this run alone holds for each turn the run takes.
      outputSpeedForTurn: this.#runRoutes.outputSpeedForTurnOf(params.runId),
      outputSchema: undefined,
      level: undefined,
      skill: undefined,
    });
  }

  // A pause a run no longer needs, because it was stopped or its turn ended, lets its calls go.
  #dropHookPause(runId: RunId): void {
    const pausedThreadId = this.#pauses.threadPausedFor(runId);
    if (pausedThreadId !== undefined) {
      this.#pauses.resume(pausedThreadId, undefined);
    }
  }

  /** Remembers an interrupted run's coming terminal; at the ceiling the conversation is let go. */
  async #rememberInterrupted(
    record: CodexSessionRecord,
    turnId: string,
    runId: RunId,
  ): Promise<boolean> {
    // A settled turn's terminal already arrived; retaining it would leave an entry nothing
    // releases.
    if (record.settledTurnIds.has(turnId) || rememberInterruptedRun(record, turnId, runId)) {
      return true;
    }
    // A session owing that many terminals is not delivering them, so it is let go rather than
    // lose one silently.
    reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
      kind: "interrupted-route-memory-overflowed",
      retainedTurnCount: record.interruptedRunIdByTurnId.size,
    });
    await this.#slots.dispose(record);
    return false;
  }

  #reportSteerUndelivered(record: CodexSessionRecord, cause: unknown): void {
    reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
      kind: "continue-steer-failed",
      threadId: record.threadId,
      detail: normalizeProviderFailureDetail(cause),
    });
  }
}
