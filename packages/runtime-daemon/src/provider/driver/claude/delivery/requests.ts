// The requests a live Claude Code process holds a run on that the daemon's own hooks do not
// answer: tool asks, the question tool (as an ask, or through the Sandboxed question hook), the
// plan a plan turn proposes, recorded as it asks to leave plan mode, the reviewer's blocks, the
// two choices and the withdrawals. Each ask is attributed to its run's
// execution first and handed to its service only once admitted; with no service registered it
// stays pending at Claude Code, and nothing answers it in the service's place.

import type { QuestionAnswer, QuestionPrompt } from "@ai-sidekicks/contracts/question";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { PermissionAskPort } from "../../../port/permission-ask.js";
import type { QuestionPort } from "../../../port/question.js";
import type { PortRegistration } from "../../../port/registration.js";
import { isPlainObject, readNonEmptyString } from "../../../record-readers.js";
import type { RespondToRequestParams } from "../../contract.js";
import type { DriverDiagnosticsEmitter } from "../../diagnostics.js";
import { composePlanProposedPayload } from "../../plan-record.js";
import { readQuestionAnswerTexts } from "../../question-answers.js";
import { CLAUDE_DRIVER_NAME } from "../capabilities.js";
import { CLAUDE_PLAN_EXIT_TOOL_NAME, CLAUDE_QUESTION_TOOL_NAME } from "../event-normalizer.js";
import { answerClaudeRequest } from "../hooks/callbacks.js";
import { CLAUDE_HOOK_CALLBACK_IDS } from "../hooks/registration.js";
import type { ClaudeBoundRun } from "../run/routes.js";
import { describeFailure, sanitizeFailureDetail } from "../session/errors.js";
import type { LiveClaudeSession } from "../session/state.js";
import type {
  ClaudeInboundControlRequest,
  ClaudeInboundRequestEvent,
} from "../session/transport.js";
import { CLAUDE_PERMISSION_MODE_BY_LEVEL } from "../spawn/arguments.js";
import { matchesClaudeReviewedRemovalRule } from "../spawn/settings.js";
import type { ClaudeProviderDialogs } from "./dialogs.js";
import type { ClaudeDeliveryDispatch } from "./dispatch.js";
import { readClaudeHookDenial, type ClaudeReviewerCapture } from "./reviewer.js";

// The decision reason of an ask an ask rule sent to the host.
const CLAUDE_RULE_DECISION = "rule";

/** A request the daemon handed, or is handing, to a service, holding the provider's answer open. */
type ClaudePendingRequestKind =
  | { readonly kind: "ask" }
  | {
      readonly kind: "question";
      /** How the question arrived, which decides the shape its answer goes back in. */
      readonly via: "ask" | "hook";
      readonly input: Readonly<Record<string, unknown>>;
      readonly questions: readonly QuestionPrompt[];
    };

/**
 * A pending request, recorded before it is attributed so a withdrawal that comes first finds it;
 * `isHandedOn` once its service has it, so a withdrawal is handed on too.
 */
type ClaudePendingRequest = ClaudePendingRequestKind & { isHandedOn: boolean };

/** What the request handling attributes, hands on and answers through. */
export interface ClaudeInboundRequestsDependencies {
  readonly dispatch: ClaudeDeliveryDispatch;
  readonly permissionAsks: PortRegistration<PermissionAskPort>;
  readonly questions: PortRegistration<QuestionPort>;
  readonly dialogs: ClaudeProviderDialogs;
  readonly reviewer: ClaudeReviewerCapture;
  readonly diagnostics: DriverDiagnosticsEmitter;
  /** The run a request belongs to: the helper's child run by its `agent_id`, else the lead's. */
  readonly runFor: (
    live: LiveClaudeSession,
    agentId: string | undefined,
  ) => ClaudeBoundRun | undefined;
  /** The permission mode the session's process last reported it runs in. */
  readonly permissionModeFor: (sessionId: SessionId) => string | undefined;
  /** Settles once a helper's child run that is being started has its route, if one is. */
  readonly childRunStarting: (sessionId: SessionId, agentId: string) => Promise<void> | undefined;
}

// The question tool's questions as the questions card asks them; a malformed one is left out.
function readQuestionPrompts(input: Readonly<Record<string, unknown>>): QuestionPrompt[] {
  const questions = input["questions"];
  if (!Array.isArray(questions)) {
    return [];
  }
  return questions.flatMap((question) => {
    if (!isPlainObject(question)) {
      return [];
    }
    const text = readNonEmptyString(question, "question");
    if (text === undefined) {
      return [];
    }
    const header = readNonEmptyString(question, "header");
    const options = Array.isArray(question["options"]) ? question["options"] : [];
    return [
      {
        ...(header === undefined ? {} : { header }),
        text,
        options: options.flatMap((option) => {
          const label = isPlainObject(option) ? readNonEmptyString(option, "label") : undefined;
          if (label === undefined || !isPlainObject(option)) {
            return [];
          }
          const description = readNonEmptyString(option, "description");
          return [{ label, ...(description === undefined ? {} : { description }) }];
        }),
        severalAnswers: question["multiSelect"] === true,
        secret: false,
      },
    ];
  });
}

/**
 * The question tool's `answers`, keyed by each question's own text, as Claude Code reads them; a
 * key by header loses the answer. Several picks join with a comma; a skipped question has no key.
 */
function composeQuestionAnswers(
  questions: readonly QuestionPrompt[],
  answers: readonly QuestionAnswer[],
): Record<string, string> {
  const composed: Record<string, string> = {};
  questions.forEach((question, index) => {
    const texts = readQuestionAnswerTexts(answers[index]);
    if (texts.length > 0) {
      composed[question.text] = texts.join(", ");
    }
  });
  return composed;
}

// The answers a questions card sent back: `{answers: QuestionAnswer[]}`, one per question.
function readQuestionAnswers(response: unknown): readonly QuestionAnswer[] {
  if (!isPlainObject(response) || !Array.isArray(response["answers"])) {
    throw new TypeError("A question is answered with every question's answer, in order.");
  }
  return response["answers"] as readonly QuestionAnswer[];
}

/** Handles the requests a Claude Code process holds runs on, and answers them. */
export class ClaudeInboundRequests {
  readonly #dependencies: ClaudeInboundRequestsDependencies;
  readonly #pendingBySession: Map<SessionId, Map<string, ClaudePendingRequest>> = new Map();
  // Requests of a helper whose child run is still being started, by session, until it has a route.
  readonly #waitingBySession: Map<SessionId, Set<string>> = new Map();

  constructor(dependencies: ClaudeInboundRequestsDependencies) {
    this.#dependencies = dependencies;
  }

  /**
   * Takes one request event the daemon's own hooks did not answer. A withdrawn ask is handed on so
   * its card settles canceled.
   */
  handle(live: LiveClaudeSession, event: ClaudeInboundRequestEvent): void {
    if (event.kind === "cancel") {
      this.#withdraw(live, event.requestId);
      return;
    }
    const request = event.request;
    const body = request.request;
    switch (request.subtype) {
      case "can_use_tool":
        this.#takeOnRun(live, request, readNonEmptyString(body, "agent_id"), (run) => {
          this.#takeToolAsk(live, request, run);
        });
        return;
      case "hook_callback": {
        const input = isPlainObject(body["input"]) ? body["input"] : {};
        this.#takeOnRun(live, request, readNonEmptyString(input, "agent_id"), (run) => {
          this.#takeHookCallback(live, request, run);
        });
        return;
      }
      case "request_user_dialog": {
        const run = this.#dependencies.runFor(live, undefined);
        if (run === undefined) {
          this.#recordUnattributed(live, request);
          return;
        }
        this.#dependencies.dialogs.takeDialog(live, request.requestId, body, run);
        return;
      }
      default:
        // An MCP elicitation or a request of a kind the daemon does not answer stays pending.
        this.#recordUnattributed(live, request);
    }
  }

  /**
   * Answers one request a run is held on under its own id: a question with `{answers}`, one per
   * question in order, composed into the question tool's own answer; any other request with the
   * provider-shaped object the caller built. Throws when the answer is not an object.
   */
  async respond(live: LiveClaudeSession, params: RespondToRequestParams): Promise<void> {
    const pending = this.#pendingBySession.get(live.sessionId)?.get(params.requestId);
    const response =
      pending?.kind === "question"
        ? composeQuestionResponse(pending, readQuestionAnswers(params.response))
        : params.response;
    if (!isPlainObject(response)) {
      throw new TypeError("A Claude Code request is answered with an object.");
    }
    await live.channel.answerInboundRequest(params.requestId, response);
    this.#pendingBySession.get(live.sessionId)?.delete(params.requestId);
  }

  /**
   * Forgets the requests of a session whose process is gone; each one a service holds is
   * withdrawn there, since nothing can answer it any more.
   */
  forgetSession(sessionId: SessionId): void {
    const pending = this.#pendingBySession.get(sessionId);
    this.#pendingBySession.delete(sessionId);
    this.#waitingBySession.delete(sessionId);
    for (const [requestId, request] of pending ?? []) {
      this.#handOnWithdrawal(sessionId, requestId, request);
    }
  }

  // Claude Code settled a request itself: an ask it withdrew goes to the approval pipeline, a
  // question to the questions card, and a choice it withdrew is recorded by the dialogs. One not
  // handed on yet is only dropped, so it never reaches its service.
  #withdraw(live: LiveClaudeSession, requestId: string): void {
    if (this.#waitingBySession.get(live.sessionId)?.delete(requestId) === true) {
      return;
    }
    const pending = this.#pendingBySession.get(live.sessionId);
    const withdrawn = pending?.get(requestId);
    pending?.delete(requestId);
    if (withdrawn === undefined) {
      this.#dependencies.dialogs.withdraw(live.sessionId, requestId);
      return;
    }
    this.#handOnWithdrawal(live.sessionId, requestId, withdrawn);
  }

  #handOnWithdrawal(
    sessionId: SessionId,
    requestId: string,
    withdrawn: ClaudePendingRequest,
  ): void {
    if (!withdrawn.isHandedOn) {
      return;
    }
    const withdrawal = { sessionId, requestId };
    const handedOn =
      withdrawn.kind === "ask"
        ? this.#dependencies.permissionAsks.port?.withdrawAsk(withdrawal)
        : this.#dependencies.questions.port?.withdrawQuestion(withdrawal);
    handedOn?.catch((error: unknown) => {
      this.#recordHandOffFailure(sessionId, null, withdrawn.kind, error);
    });
  }

  // Takes a request on its run. A helper's request can arrive before its child run has a route,
  // so it waits for that route; one withdrawn while it waits is dropped.
  #takeOnRun(
    live: LiveClaudeSession,
    request: ClaudeInboundControlRequest,
    agentId: string | undefined,
    take: (run: ClaudeBoundRun | undefined) => void,
  ): void {
    const { runFor, childRunStarting } = this.#dependencies;
    const run = runFor(live, agentId);
    const starting =
      run === undefined && agentId !== undefined
        ? childRunStarting(live.sessionId, agentId)
        : undefined;
    if (starting === undefined) {
      take(run);
      return;
    }
    const waiting = this.#waitingBySession.get(live.sessionId) ?? new Set();
    this.#waitingBySession.set(live.sessionId, waiting);
    waiting.add(request.requestId);
    void starting.then(() => {
      if (this.#waitingBySession.get(live.sessionId)?.delete(request.requestId) === true) {
        take(runFor(live, agentId));
      }
    });
  }

  #takeToolAsk(
    live: LiveClaudeSession,
    request: ClaudeInboundControlRequest,
    run: ClaudeBoundRun | undefined,
  ): void {
    const body = request.request;
    const toolName = readNonEmptyString(body, "tool_name");
    const input = isPlainObject(body["input"]) ? body["input"] : {};
    if (toolName === undefined || run === undefined) {
      this.#recordUnattributed(live, request);
      return;
    }
    if (toolName === CLAUDE_QUESTION_TOOL_NAME) {
      this.#askQuestion(live, request.requestId, run, { kind: "question", via: "ask", input });
      return;
    }
    // The plan is recorded from the request itself, which stays held on its ask until answered.
    if (toolName === CLAUDE_PLAN_EXIT_TOOL_NAME) {
      this.#recordPlan(live, run, input);
    }
    // At Reviewed only Claude Code's own removal check reaches the person; a removal the daemon's
    // `Bash(rm *)` rule sent while the process reviews in auto mode is allowed here, and every
    // other rule's ask goes to the person.
    if (
      live.executionPosture?.mode === "reviewed" &&
      body["decision_reason_type"] === CLAUDE_RULE_DECISION &&
      matchesClaudeReviewedRemovalRule(toolName, input) &&
      this.#dependencies.permissionModeFor(live.sessionId) ===
        CLAUDE_PERMISSION_MODE_BY_LEVEL.reviewed
    ) {
      answerClaudeRequest(
        live,
        request.requestId,
        { behavior: "allow", updatedInput: input },
        this.#dependencies.diagnostics,
      );
      return;
    }
    const toolCallId = readNonEmptyString(body, "tool_use_id");
    const prompt = readNonEmptyString(body, "title") ?? readNonEmptyString(body, "description");
    this.#admit(live, request.requestId, run, toolCallId, { kind: "ask" }, async (port) => {
      await port.asks?.takeAsk({
        sessionId: live.sessionId,
        runId: run.runId,
        requestId: request.requestId,
        toolName,
        input,
        ...(prompt === undefined ? {} : { prompt }),
      });
    });
  }

  #takeHookCallback(
    live: LiveClaudeSession,
    request: ClaudeInboundControlRequest,
    run: ClaudeBoundRun | undefined,
  ): void {
    const { diagnostics, reviewer } = this.#dependencies;
    const body = request.request;
    const input = isPlainObject(body["input"]) ? body["input"] : {};
    switch (readNonEmptyString(body, "callback_id")) {
      case CLAUDE_HOOK_CALLBACK_IDS.questionBridge: {
        if (input["tool_name"] !== CLAUDE_QUESTION_TOOL_NAME) {
          // A daemon tool at Sandboxed runs only on this hook's allow.
          answerClaudeRequest(
            live,
            request.requestId,
            { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } },
            diagnostics,
          );
          return;
        }
        if (run === undefined) {
          this.#recordUnattributed(live, request);
          return;
        }
        const toolInput = isPlainObject(input["tool_input"]) ? input["tool_input"] : {};
        this.#askQuestion(live, request.requestId, run, {
          kind: "question",
          via: "hook",
          input: toolInput,
        });
        return;
      }
      case CLAUDE_HOOK_CALLBACK_IDS.permissionDenied: {
        const denial = readClaudeHookDenial(input);
        if (denial !== undefined && run !== undefined) {
          reviewer.capture({ sessionId: live.sessionId, runId: run.runId, ...denial });
        }
        answerClaudeRequest(live, request.requestId, {}, diagnostics);
        return;
      }
      default:
        this.#recordUnattributed(live, request);
    }
  }

  // Claude Code puts the plan's text in the request's `plan`, and the plan file it wrote beside it.
  #recordPlan(
    live: LiveClaudeSession,
    run: ClaudeBoundRun,
    input: Readonly<Record<string, unknown>>,
  ): void {
    const text = input["plan"];
    if (typeof text !== "string" || text.trim() === "") {
      return;
    }
    const payload = composePlanProposedPayload({
      sessionId: live.sessionId,
      runId: run.runId,
      text,
      planFilePath: readNonEmptyString(input, "planFilePath"),
    });
    void this.#dependencies.dispatch.send(
      { kind: "unstamped_row", bindingId: run.bindingId, row: { type: "plan.proposed", payload } },
      "control_request/can_use_tool",
    );
  }

  #askQuestion(
    live: LiveClaudeSession,
    requestId: string,
    run: ClaudeBoundRun,
    pending: Omit<Extract<ClaudePendingRequestKind, { kind: "question" }>, "questions">,
  ): void {
    const questions = readQuestionPrompts(pending.input);
    this.#admit(live, requestId, run, undefined, { ...pending, questions }, async (port) => {
      await port.questions?.takeQuestion({
        sessionId: live.sessionId,
        runId: run.runId,
        requestId,
        questions,
      });
    });
  }

  // Holds the request pending, attributes it to its run's execution and, once admitted, hands it
  // to its service; an ask from before an undo's cut is absorbed and never shown, and one withdrawn
  // before it was admitted never reaches its service.
  #admit(
    live: LiveClaudeSession,
    requestId: string,
    run: ClaudeBoundRun,
    toolCallId: string | undefined,
    kind: ClaudePendingRequestKind,
    handOff: (ports: {
      readonly asks: PermissionAskPort | undefined;
      readonly questions: QuestionPort | undefined;
    }) => Promise<void>,
  ): void {
    const { dispatch, permissionAsks, questions } = this.#dependencies;
    const pending: ClaudePendingRequest = { ...kind, isHandedOn: false };
    const held = this.#pendingBySession.get(live.sessionId) ?? new Map();
    held.set(requestId, pending);
    this.#pendingBySession.set(live.sessionId, held);
    const admitted = dispatch.send(
      {
        kind: "permission_ask",
        bindingId: run.bindingId,
        ...(toolCallId === undefined
          ? {}
          : { operation: { correlationKey: toolCallId, isOpening: false } }),
      },
      kind.kind === "question" && kind.via === "hook"
        ? "control_request/hook_callback"
        : "control_request/can_use_tool",
    );
    void admitted.then(async (outcome) => {
      const isStillPending = this.#pendingBySession.get(live.sessionId)?.get(requestId) === pending;
      if (outcome?.disposition !== "ask_admitted") {
        if (isStillPending) {
          this.#pendingBySession.get(live.sessionId)?.delete(requestId);
        }
        return;
      }
      if (!isStillPending) {
        return;
      }
      pending.isHandedOn = true;
      await handOff({ asks: permissionAsks.port, questions: questions.port }).catch(
        (error: unknown) => {
          this.#recordHandOffFailure(live.sessionId, run.bindingId, kind.kind, error);
        },
      );
    });
  }

  #recordHandOffFailure(
    sessionId: SessionId,
    bindingId: string | null,
    requestKind: ClaudePendingRequestKind["kind"],
    error: unknown,
  ): void {
    this.#dependencies.diagnostics.emit({
      provider: CLAUDE_DRIVER_NAME,
      kind: "delivery_dispatch_failed",
      rawWireType: null,
      dispositionReason: sanitizeFailureDetail(describeFailure(error)),
      details: { deliveryKind: requestKind, sessionId, bindingId },
    });
  }

  // A request with no run to hold, or of a kind the daemon does not answer, stays pending at
  // Claude Code; the record says so.
  #recordUnattributed(live: LiveClaudeSession, request: ClaudeInboundControlRequest): void {
    this.#dependencies.diagnostics.emit({
      provider: CLAUDE_DRIVER_NAME,
      kind: "unmapped_wire_kind",
      rawWireType: `control_request/${request.subtype}`,
      dispositionReason:
        "a request Claude Code holds no daemon run on, or of a kind the daemon does not " +
        "answer, is left pending at the provider",
      details: { sessionId: live.sessionId, requestId: request.requestId },
    });
  }
}

// The question tool's answer in the shape its route takes: an ask's `allow` with the input, or the
// question hook's `allow` with it, each carrying `answers`.
function composeQuestionResponse(
  pending: Extract<ClaudePendingRequestKind, { kind: "question" }>,
  answers: readonly QuestionAnswer[],
): Record<string, unknown> {
  const updatedInput = {
    ...pending.input,
    answers: composeQuestionAnswers(pending.questions, answers),
  };
  return pending.via === "ask"
    ? { behavior: "allow", updatedInput }
    : {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput,
        },
      };
}
