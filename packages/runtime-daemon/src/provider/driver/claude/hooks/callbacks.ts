// Routes each request a live Claude Code process sends: the daemon's own pause and helper-limit
// hooks are answered here, and every other request (tool asks, dialogs, the question hook, a
// reviewer's block) goes to the event side, which answers it or leaves it pending at the provider.

import type { PermissionLevel } from "@ai-sidekicks/contracts/session/controls/methods";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { isPlainObject, readNonEmptyString } from "../../../record-readers.js";
import type { DriverDiagnosticsEmitter } from "../../diagnostics.js";
import { CLAUDE_DRIVER_NAME } from "../capabilities.js";
import { describeFailure, sanitizeFailureDetail } from "../session/errors.js";
import type { LiveClaudeSession } from "../session/state.js";
import type {
  ClaudeInboundControlRequest,
  ClaudeInboundRequestEvent,
} from "../session/transport.js";
import type { ClaudeHelperLimit } from "./helper-limit.js";
import type { ClaudePauseAnswer, ClaudeRunPauses } from "./pause.js";
import { CLAUDE_HOOK_CALLBACK_IDS } from "./registration.js";

/** What the router answers through and hands on. */
export interface ClaudeHookCallbacksDependencies {
  readonly pauses: ClaudeRunPauses;
  readonly helpers: ClaudeHelperLimit;
  /** A paused helper's next tool call is now held: its pause took effect. */
  readonly onHelperHeld: (sessionId: SessionId, agentId: string) => void;
  /** Every request the daemon's own hooks do not answer, and every withdrawal. */
  readonly forward: (live: LiveClaudeSession, event: ClaudeInboundRequestEvent) => void;
  readonly diagnostics: DriverDiagnosticsEmitter;
}

/** The fields of a `hook_callback` the daemon's own hooks read, untrusted off the wire. */
interface ClaudeHookCallbackFields {
  readonly callbackId: string | undefined;
  /** The helper's id on a callback from a helper, `undefined` on the lead's. */
  readonly agentId: string | undefined;
  readonly toolUseId: string | undefined;
}

function readHookCallbackFields(request: ClaudeInboundControlRequest): ClaudeHookCallbackFields {
  const body = request.request;
  const input = isPlainObject(body["input"]) ? body["input"] : {};
  return {
    callbackId: readNonEmptyString(body, "callback_id"),
    agentId: readNonEmptyString(input, "agent_id"),
    toolUseId: readNonEmptyString(body, "tool_use_id") ?? readNonEmptyString(input, "tool_use_id"),
  };
}

/** Answers the daemon's own hook callbacks and hands every other request on. */
export class ClaudeHookCallbacks {
  readonly #dependencies: ClaudeHookCallbacksDependencies;

  constructor(dependencies: ClaudeHookCallbacksDependencies) {
    this.#dependencies = dependencies;
  }

  /** Takes one request event off a live session's channel. */
  handle(live: LiveClaudeSession, event: ClaudeInboundRequestEvent): void {
    if (event.kind === "cancel") {
      this.#dependencies.pauses.withdrawCallback(live.sessionId, event.requestId);
      this.#dependencies.helpers.withdrawStart(live.sessionId, event.requestId);
      this.#dependencies.forward(live, event);
      return;
    }
    const request = event.request;
    if (request.subtype !== "hook_callback") {
      this.#dependencies.forward(live, event);
      return;
    }
    const fields = readHookCallbackFields(request);
    switch (fields.callbackId) {
      case CLAUDE_HOOK_CALLBACK_IDS.pauseBeforeTool:
        this.#answerPause(
          live,
          request.requestId,
          this.#dependencies.pauses.answerBeforeTool(
            live.sessionId,
            fields.agentId ?? null,
            request.requestId,
          ),
          fields.agentId,
        );
        return;
      case CLAUDE_HOOK_CALLBACK_IDS.pauseAfterBatch:
        this.#answerPause(
          live,
          request.requestId,
          this.#dependencies.pauses.answerAfterBatch(live.sessionId, fields.agentId ?? null),
          fields.agentId,
        );
        return;
      case CLAUDE_HOOK_CALLBACK_IDS.helperLimit:
        this.#answerHelperStart(live, request.requestId, fields.toolUseId ?? request.requestId);
        return;
      // Both hooks are registered at every level, since the level can move on a live process, and
      // each has work only at its own level: off it, the call passes with no decision.
      case CLAUDE_HOOK_CALLBACK_IDS.questionBridge:
        this.#forwardAtLevel(live, event, "sandboxed");
        return;
      case CLAUDE_HOOK_CALLBACK_IDS.permissionDenied:
        this.#forwardAtLevel(live, event, "reviewed");
        return;
      default:
        this.#dependencies.forward(live, event);
    }
  }

  /** Answers held callbacks once whatever held them lets go, each with its own response. */
  release(
    live: LiveClaudeSession,
    released: readonly { readonly requestId: string; readonly response: Record<string, unknown> }[],
  ): void {
    const { diagnostics } = this.#dependencies;
    for (const callback of released) {
      answerClaudeRequest(live, callback.requestId, callback.response, diagnostics);
    }
  }

  /** Admits helper starts the helper limit held, each with the empty answer that lets it run. */
  admitHelperStarts(live: LiveClaudeSession, requestIds: readonly string[]): void {
    this.release(
      live,
      requestIds.map((requestId) => ({ requestId, response: {} })),
    );
  }

  #answerPause(
    live: LiveClaudeSession,
    requestId: string,
    pauseAnswer: ClaudePauseAnswer,
    agentId: string | undefined,
  ): void {
    if (pauseAnswer.kind === "answer") {
      answerClaudeRequest(live, requestId, pauseAnswer.response, this.#dependencies.diagnostics);
      return;
    }
    if (agentId !== undefined && pauseAnswer.tookEffect) {
      this.#dependencies.onHelperHeld(live.sessionId, agentId);
    }
  }

  #forwardAtLevel(
    live: LiveClaudeSession,
    event: Extract<ClaudeInboundRequestEvent, { kind: "request" }>,
    level: PermissionLevel,
  ): void {
    if (live.executionPosture?.mode === level) {
      this.#dependencies.forward(live, event);
      return;
    }
    answerClaudeRequest(live, event.request.requestId, {}, this.#dependencies.diagnostics);
  }

  #answerHelperStart(live: LiveClaudeSession, requestId: string, toolUseId: string): void {
    if (this.#dependencies.helpers.answerStart(live.sessionId, requestId, toolUseId) === "admit") {
      answerClaudeRequest(live, requestId, {}, this.#dependencies.diagnostics);
    }
  }
}

/**
 * Answers one request Claude Code holds, without waiting. An answer that cannot be written leaves
 * Claude Code waiting on it for good, so it is recorded, the process is stopped and the restart
 * path brings the session back.
 */
export function answerClaudeRequest(
  live: LiveClaudeSession,
  requestId: string,
  response: Record<string, unknown>,
  diagnostics: DriverDiagnosticsEmitter,
): void {
  live.channel.answerInboundRequest(requestId, response).catch(async (error: unknown) => {
    diagnostics.emit({
      provider: CLAUDE_DRIVER_NAME,
      kind: "control_answer_failed",
      rawWireType: null,
      dispositionReason: sanitizeFailureDetail(describeFailure(error)),
      details: { sessionId: live.sessionId, requestId },
    });
    await live.channel.terminate();
  });
}
