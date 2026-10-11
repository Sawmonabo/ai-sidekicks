// The refusals of a request a session's shells cannot serve.

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";
import type { SubscriptionId } from "@ai-sidekicks/contracts/jsonrpc/streaming";
import {
  PTY_CHAT_UNSUPPORTED_CODE,
  PTY_NOT_FOUND_CODE,
  PTY_OUTPUT_SUBSCRIPTION_NOT_FOUND_CODE,
  type TerminalId,
} from "@ai-sidekicks/contracts/pty";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { DaemonDomainError } from "../../ipc/domain-error.js";

/** A request naming a shell its session does not have; another session's is not told apart. */
export class PtyNotFoundError extends DaemonDomainError {
  constructor(terminalId: TerminalId) {
    super(`this session has no shell ${terminalId}`, {
      code: PTY_NOT_FOUND_CODE,
      jsonRpcCode: JsonRpcErrorCode.InvalidParams,
      detail: { terminalId },
    });
  }
}

/** A take or write naming a subscription that is not the caller's own open one to the shell. */
export class PtyOutputSubscriptionNotFoundError extends DaemonDomainError {
  constructor(terminalId: TerminalId, outputSubscriptionId: SubscriptionId) {
    super(`no open output subscription of this connection to shell ${terminalId}`, {
      code: PTY_OUTPUT_SUBSCRIPTION_NOT_FOUND_CODE,
      jsonRpcCode: JsonRpcErrorCode.InvalidParams,
      detail: { terminalId, outputSubscriptionId },
    });
  }
}

/** `pty.open` on a chat session, which has no shell. */
export class PtyChatUnsupportedError extends DaemonDomainError {
  constructor(sessionId: SessionId) {
    super("A chat session has no shell.", {
      code: PTY_CHAT_UNSUPPORTED_CODE,
      detail: { sessionId },
    });
  }
}
