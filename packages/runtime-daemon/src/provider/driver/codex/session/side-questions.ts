// A side question on Codex: a throwaway, read-only copy of the conversation answers it in one
// turn, and the answer is delivered as `session.side_question_answered`. The copy runs under the
// daemon's read-only profile, which keeps the credential denies, and reaches no tool server. Its
// frames never reach the session's own routing, and the copy is let go once it answered.

import type { SessionSideQuestionAnsweredPayload } from "@ai-sidekicks/contracts/session/controls/events";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { isPlainObject, readNonEmptyString } from "../../../record-readers.js";
import { boundFailureDetail } from "../../contract.js";
import type { AskSideQuestionParams } from "../../session-control.js";
import type { CodexDeliveryDispatch } from "../delivery/dispatch.js";
import { composeCodexProfileName } from "../permission-level.js";
import type { CodexService } from "../service/supervisor.js";
import { composeCodexThreadParams } from "../thread/settings.js";
import { assertActivePermissionProfile, readThread } from "../thread/view.js";
import {
  type CodexDiagnosticSink,
  reportDiagnosticFromDetachedFrame,
} from "../transport/diagnostics.js";
import { normalizeProviderFailureDetail } from "./errors.js";
import { type CodexSessionRecord, readCodexFrameThreadId } from "./state.js";

/** One side question being answered on its copy. */
interface CodexSideQuestion {
  readonly service: CodexService;
  readonly payload: Omit<SessionSideQuestionAnsweredPayload, "answer">;
  answer: string | undefined;
}

/** What the side questions report through. */
export interface CodexSideQuestionsDependencies {
  readonly dispatch: CodexDeliveryDispatch;
  readonly reportDiagnostic: CodexDiagnosticSink;
}

/** The side questions of one lifecycle, by the copy's thread. */
export class CodexSideQuestions {
  readonly #dependencies: CodexSideQuestionsDependencies;
  readonly #questionByThreadId = new Map<string, CodexSideQuestion>();

  constructor(dependencies: CodexSideQuestionsDependencies) {
    this.#dependencies = dependencies;
  }

  /**
   * Asks the question on a read-only copy of the session's conversation and resolves once Codex
   * took it. Throws the request's failure, and `CodexTransportError` when the copy does not run
   * read-only; the copy is let go either way.
   */
  async ask(record: CodexSessionRecord, params: AskSideQuestionParams): Promise<void> {
    const service = record.service;
    const readOnlyProfile = composeCodexProfileName(
      "readonly",
      record.threadSettings.profileFolders,
    );
    const reply = await service.request("thread/fork", {
      threadId: record.threadId,
      ephemeral: true,
      excludeTurns: true,
      // A fork keeps none of the thread's inline profiles, so the copy carries the settings again.
      ...composeCodexThreadParams(record.threadSettings, undefined),
      permissions: readOnlyProfile,
      approvalPolicy: "never",
    });
    const copyThreadId = readThread(reply, "thread/fork").id;
    this.#questionByThreadId.set(copyThreadId, {
      service,
      payload: {
        sessionId: params.sessionId,
        sideQuestionId: params.sideQuestionId,
        question: params.question,
      },
      answer: undefined,
    });
    try {
      assertActivePermissionProfile(reply, readOnlyProfile, "thread/fork");
      service.registerThread(copyThreadId, params.sessionId);
      await service.request("turn/start", {
        threadId: copyThreadId,
        input: [{ type: "text", text: params.question, text_elements: [] }],
      });
    } catch (cause) {
      await this.#letGo(copyThreadId);
      throw cause;
    }
  }

  /** Takes a frame of a side question's copy, `true` when it was one. Never throws. */
  divert(method: string, params: unknown): boolean {
    const threadId = readCodexFrameThreadId(method, params);
    const question = threadId === null ? undefined : this.#questionByThreadId.get(threadId);
    if (threadId === null || question === undefined) {
      return false;
    }
    const payload = isPlainObject(params) ? params : {};
    if (method === "item/completed") {
      const item = payload["item"];
      if (isPlainObject(item) && item["type"] === "agentMessage") {
        question.answer = readNonEmptyString(item, "text") ?? question.answer;
      }
    } else if (method === "turn/completed") {
      void this.#finish(threadId, question, payload["turn"]);
    }
    return true;
  }

  /** Lets go of every copy a session's side questions still hold, once its conversation closed. */
  async forgetSession(sessionId: SessionId): Promise<void> {
    const copies = [...this.#questionByThreadId].filter(
      ([, question]) => question.payload.sessionId === sessionId,
    );
    await Promise.all(copies.map(async ([threadId]) => await this.#letGo(threadId)));
  }

  async #finish(threadId: string, question: CodexSideQuestion, turn: unknown): Promise<void> {
    const answer = question.answer;
    const sessionId = question.payload.sessionId;
    if (isPlainObject(turn) && turn["status"] === "completed" && answer !== undefined) {
      void this.#dependencies.dispatch.send(
        sessionId,
        {
          kind: "session_event",
          row: { type: "session.side_question_answered", payload: { ...question.payload, answer } },
        },
        "turn/completed",
      );
    } else {
      const error = isPlainObject(turn) ? turn["error"] : undefined;
      reportDiagnosticFromDetachedFrame(this.#dependencies.reportDiagnostic, {
        kind: "side-question-unanswered",
        sessionId,
        detail: boundFailureDetail(
          (isPlainObject(error) ? readNonEmptyString(error, "message") : undefined) ?? "",
          "The copy's turn ended with no answer.",
        ),
      });
    }
    await this.#letGo(threadId);
  }

  async #letGo(threadId: string): Promise<void> {
    const question = this.#questionByThreadId.get(threadId);
    this.#questionByThreadId.delete(threadId);
    if (question === undefined || !question.service.isRunning) {
      return;
    }
    question.service.threads.release(threadId);
    try {
      await question.service.request("thread/unsubscribe", { threadId });
    } catch (cause) {
      reportDiagnosticFromDetachedFrame(this.#dependencies.reportDiagnostic, {
        kind: "teardown-step-failed",
        step: "thread-unsubscribe",
        detail: normalizeProviderFailureDetail(cause),
      });
    }
  }
}
