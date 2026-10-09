// The asks a Codex service's connection receives for the person: each goes to the responder of the
// session its conversation belongs to, and the asks a closed connection let go of are withdrawn
// from that session's cards.

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { isPlainObject } from "../../../record-readers.js";
import type {
  CodexInboundServerRequest,
  CodexServerRequestDecision,
  CodexServerRequestResponder,
} from "../server-requests.js";
import { readCodexFrameThreadId } from "../session/state.js";
import type { CodexForgottenRequest } from "../transport/connection.js";
import {
  type CodexDiagnosticSink,
  reportDiagnosticFromDetachedFrame,
} from "../transport/diagnostics.js";
import type { CodexServiceThreads } from "./threads.js";

/** What routing one service's asks reads and reports to. */
export interface CodexServiceAsksDependencies {
  readonly threads: CodexServiceThreads;
  readonly responderFor: (sessionId: SessionId) => CodexServerRequestResponder | undefined;
  readonly onHeldRequestsDropped: (
    sessionId: SessionId,
    dropped: readonly CodexForgottenRequest[],
  ) => void;
  readonly reportDiagnostic: CodexDiagnosticSink;
}

/** Routes one service's asks to their sessions; withdraws those a closed connection let go. */
export class CodexServiceAsks {
  readonly #dependencies: CodexServiceAsksDependencies;

  constructor(dependencies: CodexServiceAsksDependencies) {
    this.#dependencies = dependencies;
  }

  /** Hands one ask to the responder of the session its thread belongs to, or refuses it. */
  async answer(request: CodexInboundServerRequest): Promise<CodexServerRequestDecision> {
    const threadId =
      readCodexFrameThreadId(request.method, request.params) ??
      readLegacyConversationId(request.params);
    const sessionId =
      threadId === null ? undefined : this.#dependencies.threads.sessionFor(threadId);
    if (sessionId === undefined) {
      this.#report({ kind: "routed-ask-thread-unresolved", method: request.method, threadId });
      return {
        decision: "refuse",
        reason:
          `The provider's "${request.method}" request named no conversation this daemon holds, ` +
          `so no session can answer it.`,
      };
    }
    const responder = this.#dependencies.responderFor(sessionId);
    if (responder === undefined) {
      this.#report({ kind: "unrouted-server-request-refused", method: request.method });
      return {
        decision: "refuse",
        reason:
          `The daemon has no responder registered for "${request.method}"; refusing rather ` +
          `than answering without adjudication.`,
      };
    }
    return await responder.answer(request);
  }

  /** Withdraws each dropped ask's card on the session its conversation belongs to. */
  withdrawDropped(dropped: readonly CodexForgottenRequest[]): void {
    const bySession = new Map<SessionId, CodexForgottenRequest[]>();
    for (const request of dropped) {
      const sessionId =
        request.threadId === null
          ? undefined
          : this.#dependencies.threads.sessionFor(request.threadId);
      if (sessionId !== undefined) {
        bySession.set(sessionId, [...(bySession.get(sessionId) ?? []), request]);
      }
    }
    for (const [sessionId, requests] of bySession) {
      this.#dependencies.onHeldRequestsDropped(sessionId, requests);
    }
  }

  #report(diagnostic: Parameters<CodexDiagnosticSink>[0]): void {
    reportDiagnosticFromDetachedFrame(this.#dependencies.reportDiagnostic, diagnostic);
  }
}

// The thread a legacy approval names, which it calls its conversation.
function readLegacyConversationId(params: unknown): string | null {
  const conversationId = isPlainObject(params) ? params["conversationId"] : undefined;
  return typeof conversationId === "string" && conversationId.length > 0 ? conversationId : null;
}
