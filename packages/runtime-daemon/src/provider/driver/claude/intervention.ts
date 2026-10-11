// The Claude driver's interventions on a running turn: a steer is a user message written into the
// turn with its staged files, which Claude Code reads at its next step, and an interrupt is Claude
// Code's `interrupt`.
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
// the daemon's verdict lands first; an interrupt Claude Code never got delivers it as sent. The
// interrupt never drops Claude Code's own queue: the run queue takes back what an interrupt's
// choice keeps from the next turn, by each message's id, before the interrupt goes.

import {
  DriverInterventionResultSchema,
  type DriverInterventionResult,
} from "@ai-sidekicks/contracts/provider/driver/intervention";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { AttachmentResolver } from "../attachments.js";
import { SteerTurnEndedError, type ApplyInterventionParams } from "../run-control.js";
import { composeClaudeAttachmentBlocks } from "./attachments.js";
import { ClaudeRequestTimeoutError, ClaudeSessionUnavailableError } from "./session/errors.js";
import { attemptClaudeFrameWrite } from "./session/stdin-write.js";
import type {
  ClaudeControlRequest,
  ClaudeControlResponse,
  ClaudeProviderProcess,
  ClaudeRunProcessLookup,
  ClaudeUserContentBlock,
} from "./session/transport.js";

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
   * Sends a message and its files' blocks as the session's next turn, its own run, once the ended
   * run's turn is released, and resolves with that run's id. Throws `session_turn_in_flight` when
   * the turn is not released within the request deadline.
   */
  sendAsNextTurn(
    sessionId: SessionId,
    content: string,
    messageId: string,
    attachmentBlocks: readonly ClaudeUserContentBlock[],
  ): Promise<RunId>;
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
  readonly attachments: AttachmentResolver;
  /**
   * Records a steer about to be written into the run's turn, the newest message its session was
   * sent, before the write, since Claude Code may replay it before the write settles.
   */
  readonly onSteerSent: (runId: RunId, messageUuid: string) => void;
  /** Forgets a steer whose write failed, which Claude Code never takes. */
  readonly onSteerUnsent: (runId: RunId, messageUuid: string) => void;
}

/** Applies interventions to Claude runs; every arm resolves to a `DriverInterventionResult`. */
export class ClaudeInterventionDispatcher {
  readonly #dependencies: ClaudeInterventionDispatcherDependencies;
  // Each session's newest steer, settled either way, which the next one waits for; dropped once
  // no later steer follows it.
  readonly #lastSteerBySession = new Map<SessionId, Promise<void>>();

  constructor(dependencies: ClaudeInterventionDispatcherDependencies) {
    this.#dependencies = dependencies;
  }

  /**
   * Writes a steer and its files into the run's turn and sends an interrupt as Claude Code's
   * `interrupt`. Steers on one session are written in the order they were handed over, however
   * long their files take to read. Throws `ClaudeSessionUnavailableError` when the run has no
   * channel, `SteerTurnEndedError` when the run's turn ended before its steer could go, the files'
   * resolution or read failure before anything is sent, and a failed steer write's cause; nothing
   * is written twice.
   */
  async applyIntervention(params: ApplyInterventionParams): Promise<DriverInterventionResult> {
    const { settlement } = this.#dependencies;
    // A run apart from the session's process has no channel; a stop ends its own process.
    if (params.type === "interrupt" && settlement.stopApartRun(params.targetRunId)) {
      return DriverInterventionResultSchema.parse({ status: "applied" });
    }
    const { channelLookup } = this.#dependencies;
    const channel = channelLookup.findProcessForRun(params.targetRunId);
    const sessionId = channelLookup.sessionIdForRun(params.targetRunId);
    if (channel === undefined || sessionId === undefined) {
      throw new ClaudeSessionUnavailableError("no_live_run", { runId: params.targetRunId });
    }
    switch (params.type) {
      case "steer": {
        // Its files are read from the moment it is handed over, and it takes its place behind the
        // session's steer before it with nothing awaited, so the order it came in is kept.
        const attachmentBlocks = composeClaudeAttachmentBlocks(
          this.#dependencies.attachments,
          sessionId,
          params.payload.attachments,
        );
        const previousSteer = this.#lastSteerBySession.get(sessionId) ?? Promise.resolve();
        const steer = Promise.all([previousSteer, attachmentBlocks]).then(
          async ([, blocks]) => await this.#writeSteer(channel, params, blocks),
        );
        const settled = Promise.allSettled([previousSteer, steer]).then(() => undefined);
        this.#lastSteerBySession.set(sessionId, settled);
        void settled.then(() => {
          if (this.#lastSteerBySession.get(sessionId) === settled) {
            this.#lastSteerBySession.delete(sessionId);
          }
        });
        return await steer;
      }
      case "interrupt": {
        return await this.#dispatchInterrupt(channel, params.targetRunId);
      }
    }
  }

  // Writes one steer and its files, or, when settling the choice the run was held on ended it,
  // sends them as the session's next turn. A file that cannot be read has settled nothing.
  async #writeSteer(
    channel: ClaudeProviderProcess,
    params: Extract<ApplyInterventionParams, { type: "steer" }>,
    attachmentBlocks: readonly ClaudeUserContentBlock[],
  ): Promise<DriverInterventionResult> {
    const { settlement } = this.#dependencies;
    const nextTurnSessionId = await settlement.settleChoiceForMessage(params.targetRunId);
    if (nextTurnSessionId !== undefined) {
      const deliveredRunId = await settlement.sendAsNextTurn(
        nextTurnSessionId,
        params.payload.content,
        params.clientIdempotencyKey,
        attachmentBlocks,
      );
      return DriverInterventionResultSchema.parse({ status: "applied", deliveredRunId });
    }
    // The run's turn may have ended while the steer waited for the one before it and its files; an
    // idle process would start a turn of its own with it.
    if (this.#dependencies.channelLookup.findProcessForRun(params.targetRunId) !== channel) {
      throw new SteerTurnEndedError(params.targetRunId);
    }
    this.#dependencies.onSteerSent(params.targetRunId, params.clientIdempotencyKey);
    const attempt = await attemptClaudeFrameWrite(
      channel,
      { text: params.payload.content, origin: "human_text" },
      params.clientIdempotencyKey,
      attachmentBlocks,
    );
    if (attempt.settled === "failed") {
      this.#dependencies.onSteerUnsent(params.targetRunId, params.clientIdempotencyKey);
      throw attempt.cause;
    }
    return DriverInterventionResultSchema.parse({ status: "applied" });
  }

  async #dispatchInterrupt(
    channel: ClaudeProviderProcess,
    targetRunId: RunId,
  ): Promise<DriverInterventionResult> {
    const { settlement } = this.#dependencies;
    if (await settlement.settleChoiceForInterrupt(targetRunId)) {
      return DriverInterventionResultSchema.parse({ status: "applied" });
    }
    settlement.holdTurnEndForInterrupt(targetRunId);
    let outcome: ClaudeInterruptOutcome;
    try {
      outcome = await sendClaudeInterrupt(channel, { subtype: "interrupt" });
    } catch (error) {
      settlement.settleInterrupt(targetRunId, false);
      throw error;
    }
    // Every answer, a refusal included, is a verdict the daemon ends the run with.
    settlement.settleInterrupt(targetRunId, true);
    if (outcome.kind === "answered" && outcome.response.subtype === "error") {
      // The key is omitted, not `undefined`, because the envelope is `.strict()`.
      return DriverInterventionResultSchema.parse({ status: "degraded" });
    }
    return DriverInterventionResultSchema.parse({ status: "applied" });
  }
}
