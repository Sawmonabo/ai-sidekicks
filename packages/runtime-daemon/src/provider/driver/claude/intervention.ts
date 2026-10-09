// The Claude driver's interventions on a running turn: a steer is a user message written into the
// turn, which Claude Code reads at its next step, and an interrupt is Claude Code's `interrupt`.
//
// Failure polarity, for every arm:
//   * A typed `control_response` error means the provider answered and refused: `degraded`, with
//     no `fallbackAction`, because no fallback is documented for a refused interrupt.
//   * A transport failure (broken pipe, dead process) propagates; `degraded` asserts the request
//     reached the provider. An interrupt left unanswered past its deadline stops the process
//     instead, which ends the turn, and the restart path brings the session back.
//   * No live channel for the target run propagates as `ClaudeSessionUnavailableError`; that is a
//     routing fault, not an unsupported capability.
//
// The interrupt's idempotency key has no wire field, so it is not sent. A steer's key is the
// message's own id, so a withdraw can name it. A choice Claude Code holds the run on is settled
// before either goes; a steer whose settlement ended the run starts the session's next turn
// instead, naming that run as the one its message went to. The turn end an interrupt causes is held
// until Claude Code answers, then delivered as `interrupted`, so the run ends whether that end or
// the daemon's verdict lands first; an interrupt Claude Code never got delivers it as sent.

import {
  DriverInterventionResultSchema,
  type ApplyInterventionParams,
  type DriverInterventionResult,
  type InterruptPayload,
} from "@ai-sidekicks/contracts/provider/driver/intervention";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { isPlainObject } from "../../record-readers.js";
import { ClaudeRequestTimeoutError, ClaudeSessionUnavailableError } from "./session/errors.js";
import { attemptClaudeFrameWrite } from "./session/stdin-write.js";
import type {
  ClaudeControlRequest,
  ClaudeControlResponse,
  ClaudeProviderProcess,
  ClaudeRunProcessLookup,
} from "./session/transport.js";

// The `system/init` capability that makes `interrupt` take `cancel_queued`.
const CLAUDE_INTERRUPT_CANCEL_QUEUED_CAPABILITY = "interrupt_cancel_queued_v1";

// Key of the uuids of queued user messages that outlived an interrupt.
const CLAUDE_INTERRUPT_RECEIPT_SURVIVOR_KEY = "still_queued";

/** How an interrupt settled: Claude Code's answer, or a process stopped because it gave none. */
export type ClaudeInterruptOutcome =
  | { readonly kind: "answered"; readonly response: ClaudeControlResponse }
  | { readonly kind: "stopped" };

/**
 * Sends `interrupt`; a process that does not answer within the request deadline is stopped, which
 * ends its turn as surely, and its exit takes the restart path.
 */
export async function sendClaudeInterrupt(
  channel: ClaudeProviderProcess,
  request: Extract<ClaudeControlRequest, { subtype: "interrupt" }>,
): Promise<ClaudeInterruptOutcome> {
  try {
    return { kind: "answered", response: await channel.sendControlRequest(request) };
  } catch (error) {
    if (!(error instanceof ClaudeRequestTimeoutError)) {
      throw error;
    }
    await channel.terminate();
    return { kind: "stopped" };
  }
}

// Survivors are counted only from an array: a missing or malformed list reads as none, so a build
// that sends no receipt does not fail a queue-dropping interrupt closed.
function countSurvivingQueuedMessages(payload: Record<string, unknown> | undefined): number {
  const survivors = payload?.[CLAUDE_INTERRUPT_RECEIPT_SURVIVOR_KEY];
  return Array.isArray(survivors) ? survivors.length : 0;
}

/** What an interrupt and a steer settle on the driver's side before and after they go. */
export interface ClaudeInterventionSettlement {
  /**
   * Settles a choice the run is held on before its interrupt, answering `true` when that ended the
   * run, so no interrupt is sent.
   */
  settleChoiceForInterrupt(runId: RunId): Promise<boolean>;
  /**
   * Settles a choice the run is held on before a message the person sent goes to Claude Code,
   * answering the run's session when that ended the run, so the message starts its next turn.
   */
  settleChoiceForMessage(runId: RunId): Promise<SessionId | undefined>;
  /**
   * Sends a message as the session's next turn, its own run, once the ended run's turn is released,
   * and resolves with that run's id. Throws `session_turn_in_flight` when the turn is not released
   * within the request deadline.
   */
  sendAsNextTurn(sessionId: SessionId, content: string, messageId: string): Promise<RunId>;
  /** The interrupt is about to go, so the run's turn end is held until it settles. */
  holdTurnEndForInterrupt(runId: RunId): void;
  /**
   * The interrupt settled: `isAnswered` when Claude Code answered it, and the run's turn end, held
   * or still coming, is delivered as `interrupted`; otherwise it is delivered as Claude Code sends
   * it.
   */
  settleInterrupt(runId: RunId, isAnswered: boolean): void;
  /**
   * Stops a run apart from its session's process, such as a review of the staged changes, whose
   * end the daemon then writes; answers `false` for any other run.
   */
  stopApartRun(runId: RunId): boolean;
}

/** What the dispatcher reaches a run's process through. */
export interface ClaudeInterventionDispatcherDependencies {
  readonly channelLookup: ClaudeRunProcessLookup;
  readonly settlement: ClaudeInterventionSettlement;
  /** Records a steer written into the run's turn, the newest message its session was sent. */
  readonly onSteerSent: (runId: RunId, messageUuid: string) => void;
}

/** Applies interventions to Claude runs; every arm resolves to a `DriverInterventionResult`. */
export class ClaudeInterventionDispatcher {
  readonly #dependencies: ClaudeInterventionDispatcherDependencies;

  constructor(dependencies: ClaudeInterventionDispatcherDependencies) {
    this.#dependencies = dependencies;
  }

  /**
   * Writes a steer into the run's turn and sends an interrupt as Claude Code's `interrupt`.
   * Throws `ClaudeSessionUnavailableError` when the run has no channel, and a failed steer write's
   * cause; nothing is written twice.
   */
  async applyIntervention(params: ApplyInterventionParams): Promise<DriverInterventionResult> {
    const { settlement } = this.#dependencies;
    // A run apart from the session's process has no channel; a stop ends its own process.
    if (params.type === "interrupt" && settlement.stopApartRun(params.targetRunId)) {
      return DriverInterventionResultSchema.parse({ status: "applied" });
    }
    const channel = this.#dependencies.channelLookup.findProcessForRun(params.targetRunId);
    if (channel === undefined) {
      throw new ClaudeSessionUnavailableError("no_live_run", { runId: params.targetRunId });
    }
    switch (params.type) {
      case "steer": {
        const nextTurnSessionId = await settlement.settleChoiceForMessage(params.targetRunId);
        if (nextTurnSessionId !== undefined) {
          const deliveredRunId = await settlement.sendAsNextTurn(
            nextTurnSessionId,
            params.payload.content,
            params.clientIdempotencyKey,
          );
          return DriverInterventionResultSchema.parse({ status: "applied", deliveredRunId });
        }
        const attempt = await attemptClaudeFrameWrite(
          channel,
          { text: params.payload.content, origin: "human_text" },
          params.clientIdempotencyKey,
        );
        if (attempt.settled === "failed") {
          throw attempt.cause;
        }
        this.#dependencies.onSteerSent(params.targetRunId, params.clientIdempotencyKey);
        return DriverInterventionResultSchema.parse({ status: "applied" });
      }
      case "interrupt": {
        return await this.#dispatchInterrupt(channel, params.targetRunId, params.payload);
      }
    }
  }

  async #dispatchInterrupt(
    channel: ClaudeProviderProcess,
    targetRunId: RunId,
    payload: InterruptPayload,
  ): Promise<DriverInterventionResult> {
    const { settlement } = this.#dependencies;
    if (await settlement.settleChoiceForInterrupt(targetRunId)) {
      return DriverInterventionResultSchema.parse({ status: "applied" });
    }
    // Waiting messages go back to the draft only where the process can drop them; elsewhere they
    // stay queued and go as the next turn.
    const cancelQueued =
      payload.pending === "returnToDraft" &&
      this.#dependencies.channelLookup
        .advertisedCapabilitiesForRun(targetRunId)
        .has(CLAUDE_INTERRUPT_CANCEL_QUEUED_CAPABILITY);
    settlement.holdTurnEndForInterrupt(targetRunId);
    let outcome: ClaudeInterruptOutcome;
    try {
      outcome = await sendClaudeInterrupt(
        channel,
        cancelQueued ? { subtype: "interrupt", cancel_queued: true } : { subtype: "interrupt" },
      );
    } catch (error) {
      settlement.settleInterrupt(targetRunId, false);
      throw error;
    }
    // Every answer, a refusal included, is a verdict the daemon ends the run with.
    settlement.settleInterrupt(targetRunId, true);
    if (outcome.kind === "stopped") {
      return DriverInterventionResultSchema.parse({ status: "applied" });
    }
    const response = outcome.response;
    if (response.subtype === "error") {
      // The key is omitted, not `undefined`, because the envelope is `.strict()`.
      return DriverInterventionResultSchema.parse({ status: "degraded" });
    }
    const receipt = isPlainObject(response.response) ? response.response : undefined;
    if (cancelQueued && countSurvivingQueuedMessages(receipt) > 0) {
      // Survivors are already queued, so `queue_and_interrupt` would queue them twice.
      return DriverInterventionResultSchema.parse({ status: "degraded" });
    }
    return DriverInterventionResultSchema.parse({ status: "applied" });
  }
}
