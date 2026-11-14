// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The status line under a running tool call: the provider's own words for its progress, live and keyed per call, never stored.

import type { SubscribeAcknowledgmentResponse } from "./jsonrpc/streaming.js";
import type { ToolCallId } from "./provider/tool-call.js";
import type { SessionId } from "./session/id.js";

/**
 * The longest status line, in code points: the size of the longest one-line text a provider
 * reports.
 */
export const TOOL_CALL_STATUS_MAX_LEN = 512 as const;

/**
 * The session whose tool calls' status lines an `agent.toolCall.status.subscribe` subscription
 * follows.
 */
export interface AgentToolCallStatusSubscribeRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
}
/**
 * One tool call's status line.
 */
export interface ToolCallStatusUpdate {
  /**
   * The tool call.
   */
  toolCallId: ToolCallId;
  /**
   * The call's newest status line, or `null` once the call closed, after which the key sends
   * nothing more.
   */
  status: string | null;
}

/** The methods of {@link TOOL_CALL_STATUS_METHOD_DESCRIPTORS}, each with its kind. */
export interface ToolCallStatusMethodDescriptors {
  readonly "agent.toolCall.status.subscribe": {
    readonly method: "agent.toolCall.status.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
  };
}
/** The params, result and emission types of each method of {@link TOOL_CALL_STATUS_METHOD_DESCRIPTORS}. */
export interface ToolCallStatusMethodTypes {
  readonly "agent.toolCall.status.subscribe": {
    readonly params: AgentToolCallStatusSubscribeRequest;
    readonly result: SubscribeAcknowledgmentResponse;
    readonly emission: ToolCallStatusUpdate;
  };
}
/** The status lines of a session's running tool calls. */
export const TOOL_CALL_STATUS_METHOD_DESCRIPTORS: ToolCallStatusMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "agent.toolCall.status.subscribe": /* @__PURE__ */ Object.freeze({
      method: "agent.toolCall.status.subscribe",
      procedureType: "subscription",
      mutating: false,
    }),
  });
