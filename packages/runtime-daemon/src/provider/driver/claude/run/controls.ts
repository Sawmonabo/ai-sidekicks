// The controls on a live Claude run: its interrupt, pause and continue by the daemon's own hooks,
// taking back a message Claude Code has not read yet, answering a request or a choice Claude Code
// holds the run on, and the person's `Allow once` on a block by Claude Code's reviewer. A choice
// is settled before an interrupt or a message goes, as Claude Code itself would settle it. A turn
// the daemon starts with no run holding the session's turn starts as the session's own run.

import type { InterruptRunParams } from "@ai-sidekicks/contracts/provider/driver/intervention";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { mintUuidV7 } from "../../../../uuid-v7.js";
import type { OutboundText } from "../../../outbound-text.js";
import { isPlainObject } from "../../../record-readers.js";
import type { RespondToRequestParams } from "../../contract.js";
import type {
  AnswerProviderChoiceParams,
  AnswerProviderChoiceResult,
  OverrideDenialParams,
  PauseRunParams,
  ResumeRunParams,
  WaitingMessage,
  WithdrawQueuedMessageParams,
  WithdrawQueuedMessageResult,
} from "../../run-control.js";
import type { ClaudeProviderDialogs } from "../delivery/dialogs.js";
import type { ClaudeInboundRequests } from "../delivery/requests.js";
import { composeClaudeOverrideSentence } from "../delivery/reviewer.js";
import type { ClaudeDeliveryStream } from "../delivery/stream.js";
import type { ClaudeHookCallbacks } from "../hooks/callbacks.js";
import type { ClaudeRunPauses } from "../hooks/pause.js";
import { sendClaudeInterrupt, type ClaudeInterventionSettlement } from "../intervention.js";
import { ClaudeSessionUnavailableError } from "../session/errors.js";
import type { ClaudeSessionSlots } from "../session/slots.js";
import type { LiveClaudeSession } from "../session/state.js";
import { attemptClaudeFrameWrite } from "../session/stdin-write.js";
import {
  CLAUDE_REQUEST_DEADLINE_MS,
  ClaudeControlRequestRefusedError,
} from "../session/transport.js";
import type { ClaudeSentPrompts } from "./prompts.js";
import type { ClaudeRunRoutes } from "./routes.js";
import type { ClaudeDaemonTurnOpening } from "./start.js";

/** What the run controls act through. */
export interface ClaudeRunControlsDependencies {
  readonly slots: ClaudeSessionSlots;
  readonly runRoutes: ClaudeRunRoutes;
  readonly pauses: ClaudeRunPauses;
  readonly hookCallbacks: ClaudeHookCallbacks;
  readonly dialogs: ClaudeProviderDialogs;
  readonly requests: ClaudeInboundRequests;
  readonly stream: ClaudeDeliveryStream;
  /** Starts a turn the daemon starts on the session itself as the session's own run. */
  readonly startDaemonTurn: (
    live: LiveClaudeSession,
    opening: ClaudeDaemonTurnOpening,
  ) => Promise<RunId>;
  readonly prompts: ClaudeSentPrompts;
}

// A helper continued with words reads them as the reason its held call was refused.
function composeHelperSteer(messages: readonly WaitingMessage[]): string | undefined {
  return messages.length === 0
    ? undefined
    : messages.map((message) => message.content).join("\n\n");
}

/** Interrupt, pause, continue, withdraw and answers on live Claude runs. */
export class ClaudeRunControls implements ClaudeInterventionSettlement {
  readonly #dependencies: ClaudeRunControlsDependencies;

  constructor(dependencies: ClaudeRunControlsDependencies) {
    this.#dependencies = dependencies;
  }

  /**
   * Stops the run's turn with Claude Code's `interrupt`, its turn end then delivered as
   * `interrupted`; a refusal Claude Code holds the run on is settled `cancelled` instead, which
   * ends the run refused, and a run apart from the session's process stops with that process.
   * Throws with no live run and `ClaudeControlRequestRefusedError` when Claude Code refuses.
   */
  async interruptRun(params: InterruptRunParams): Promise<void> {
    // A run apart from the session's process stops with its own process and ends interrupted.
    if (this.#dependencies.runRoutes.stopApartRun(params.runId, false)) {
      return;
    }
    const live = this.#liveSessionForRun(params.runId);
    const { dialogs, stream } = this.#dependencies;
    if (await dialogs.settleForInterrupt(live, params.runId)) {
      return;
    }
    // `params.reason` has no wire member. A refusal throws, since returning would claim an
    // interrupt that did not happen.
    stream.markInterrupted(live.sessionId, params.runId);
    try {
      const outcome = await sendClaudeInterrupt(live.channel, { subtype: "interrupt" });
      if (outcome.kind === "answered" && outcome.response.subtype === "error") {
        throw new ClaudeControlRequestRefusedError("interrupt", outcome.response.error);
      }
    } catch (error) {
      stream.unmarkInterrupted(live.sessionId, params.runId);
      throw error;
    }
  }

  /** Settles a choice the run is held on before an intervention's interrupt goes. */
  async settleChoiceForInterrupt(runId: RunId): Promise<boolean> {
    return await this.#dependencies.dialogs.settleForInterrupt(
      this.#liveSessionForRun(runId),
      runId,
    );
  }

  /** Settles a choice the run is held on before a message the person sent goes. */
  async settleChoiceForMessage(runId: RunId): Promise<SessionId | undefined> {
    const live = this.#liveSessionForRun(runId);
    return (await this.#dependencies.dialogs.settleForQueuedMessage(live, runId))
      ? live.sessionId
      : undefined;
  }

  /** Sends a message as the session's next turn once the ended run releases its turn. */
  async sendAsNextTurn(sessionId: SessionId, content: string, messageId: string): Promise<RunId> {
    const { runRoutes, startDaemonTurn } = this.#dependencies;
    if (!(await runRoutes.whenTurnReleased(sessionId, CLAUDE_REQUEST_DEADLINE_MS))) {
      throw new ClaudeSessionUnavailableError("session_turn_in_flight", { sessionId });
    }
    return await startDaemonTurn(this.#requireLive(sessionId), {
      kind: "text",
      text: { text: content, origin: "human_text" },
      messageId,
    });
  }

  /** Stops a run apart from its session's process; the daemon writes its end. */
  stopApartRun(runId: RunId): boolean {
    return this.#dependencies.runRoutes.stopApartRun(runId, true);
  }

  /** Holds the turn end an intervention's interrupt causes until the interrupt settles. */
  holdTurnEndForInterrupt(runId: RunId): void {
    this.#dependencies.stream.markDaemonEnded(runId, false);
  }

  /** Delivers the held turn end as `interrupted` once answered, else as Claude Code sent it. */
  settleInterrupt(runId: RunId, isAnswered: boolean): void {
    if (isAnswered) {
      this.#dependencies.stream.interruptDaemonEnd(runId);
    } else {
      this.#dependencies.stream.releaseDaemonEnd(runId);
    }
  }

  /**
   * Pauses the lead run or a helper's child run from its next step on. Resolves at once: the
   * pause takes effect at the run's next hook, which reports it. Throws with no live session.
   */
  pauseRun(params: PauseRunParams): void {
    this.#requireLive(params.sessionId);
    const child = this.#dependencies.runRoutes.childRouteFor(params.runId);
    if (child !== undefined) {
      this.#dependencies.pauses.pauseHelper(params.sessionId, child.agentId);
      return;
    }
    this.#dependencies.pauses.pauseLead(params.sessionId, params.runId);
  }

  /**
   * Continues a run with the messages that waited for it. A helper's held call is answered, with
   * the messages as the person's words when there are any; the lead's waiting messages go as user
   * messages, the first of them starting its next turn when its last one ended on the pause.
   * Throws with no live session, `session_turn_in_flight` while another turn holds the session,
   * and a failed write's cause.
   */
  async resumeRun(params: ResumeRunParams): Promise<void> {
    const live = this.#requireLive(params.sessionId);
    const { runRoutes, pauses, hookCallbacks } = this.#dependencies;
    const child = runRoutes.childRouteFor(params.runId);
    if (child !== undefined) {
      const steer = composeHelperSteer(params.messages);
      hookCallbacks.release(live, pauses.resumeHelper(params.sessionId, child.agentId, steer));
      return;
    }
    // The run holds the session's turn again, so the turn its messages start ends on its route;
    // while another run or a command holds it, the messages would land in that turn instead, so
    // nothing is continued.
    if (params.messages.length > 0 && runRoutes.sessionIdFor(params.runId) !== params.sessionId) {
      if (runRoutes.isTurnHeld(params.sessionId)) {
        throw new ClaudeSessionUnavailableError("session_turn_in_flight", {
          sessionId: params.sessionId,
          runId: params.runId,
        });
      }
      if (!runRoutes.holdTurnAgain(params.runId, params.sessionId)) {
        throw new ClaudeSessionUnavailableError("run_dispatch_unresolved", {
          sessionId: params.sessionId,
          runId: params.runId,
        });
      }
    }
    pauses.resumeLead(params.sessionId);
    for (const message of params.messages) {
      await this.#writeMessage(live, message.content, message.id);
    }
  }

  /**
   * Takes back a message written into a running turn: `withdrawn` before Claude Code read it,
   * `already_delivered` once it had. Throws with no live session and when the request is refused.
   */
  async withdrawQueuedMessage(
    params: WithdrawQueuedMessageParams,
  ): Promise<WithdrawQueuedMessageResult> {
    const live = this.#requireLive(params.sessionId);
    const response = await live.channel.sendControlRequest({
      subtype: "cancel_async_message",
      message_uuid: params.clientIdempotencyKey,
    });
    if (response.subtype === "error") {
      throw new ClaudeControlRequestRefusedError("cancel_async_message", response.error);
    }
    if (isPlainObject(response.response) && response.response["cancelled"] === true) {
      this.#dependencies.prompts.forgetSent(params.sessionId, params.clientIdempotencyKey);
      return { status: "withdrawn" };
    }
    return { status: "already_delivered" };
  }

  /**
   * Answers one request Claude Code holds a run on, the lead's or a helper's, under its own id; see
   * {@link ClaudeInboundRequests.respond}. Throws with no live run.
   */
  async respondToRequest(params: RespondToRequestParams): Promise<void> {
    await this.#dependencies.requests.respond(this.#liveSessionForRun(params.runId), params);
  }

  /** Sends the person's answer to a choice a run is held on; see {@link ClaudeProviderDialogs}. */
  async answerProviderChoice(
    params: AnswerProviderChoiceParams,
  ): Promise<AnswerProviderChoiceResult> {
    return await this.#dependencies.dialogs.answer(
      this.#dependencies.slots.findLiveSession(params.sessionId),
      params,
    );
  }

  /**
   * Sends the sentence Claude Code's own `Allow once` sends, which retries nothing itself: into the
   * running turn, or as the session's own run while no run holds its turn. Throws for a malformed
   * denial, and as the write or the run's start throws.
   */
  async overrideDenial(params: OverrideDenialParams): Promise<void> {
    const live = this.#requireLive(params.sessionId);
    const text: OutboundText = {
      text: composeClaudeOverrideSentence(params.providerDenial),
      origin: "system_narration",
    };
    if (this.#dependencies.runRoutes.leadRunOn(params.sessionId) === undefined) {
      await this.#dependencies.startDaemonTurn(live, {
        kind: "text",
        text,
        messageId: mintUuidV7(),
      });
      return;
    }
    await this.#writeMessage(live, text, mintUuidV7());
  }

  async #writeMessage(
    live: LiveClaudeSession,
    outboundText: OutboundText | string,
    messageUuid: string,
  ): Promise<void> {
    const attempt = await attemptClaudeFrameWrite(
      live.channel,
      typeof outboundText === "string"
        ? { text: outboundText, origin: "human_text" }
        : outboundText,
      messageUuid,
    );
    if (attempt.settled === "failed") {
      throw attempt.cause;
    }
    this.#dependencies.prompts.recordSent(live.sessionId, messageUuid);
  }

  // The live session of a lead run or of a helper's child run.
  #liveSessionForRun(runId: RunId): LiveClaudeSession {
    const { runRoutes, slots } = this.#dependencies;
    const sessionId = runRoutes.sessionIdFor(runId) ?? runRoutes.childRouteFor(runId)?.sessionId;
    const live = sessionId === undefined ? undefined : slots.findLiveSession(sessionId);
    if (live === undefined) {
      throw new ClaudeSessionUnavailableError("no_live_run", { runId });
    }
    return live;
  }

  #requireLive(sessionId: SessionId): LiveClaudeSession {
    const live = this.#dependencies.slots.findLiveSession(sessionId);
    if (live === undefined) {
      throw new ClaudeSessionUnavailableError("no_live_session", { sessionId });
    }
    return live;
  }
}
