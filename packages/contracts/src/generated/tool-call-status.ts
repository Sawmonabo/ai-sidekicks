// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The status line under a running tool call: the provider's own words for its progress, live and keyed per call, never stored.

import type { SchemaCheck } from "../schema-check.js";
import { validateSubscribeAcknowledgmentResponse } from "./checks/jsonrpc/streaming.js";
import {
  validateAgentToolCallStatusSubscribeRequest,
  validateToolCallStatusUpdate,
} from "./checks/tool-call-status.js";
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

export {
  validateAgentToolCallStatusSubscribeRequest,
  validateToolCallStatusUpdate,
} from "./checks/tool-call-status.js";

/** The methods of {@link TOOL_CALL_STATUS_METHOD_DESCRIPTORS}, each with its checks. */
export interface ToolCallStatusMethodDescriptors {
  readonly "agent.toolCall.status.subscribe": {
    readonly method: "agent.toolCall.status.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<AgentToolCallStatusSubscribeRequest>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<ToolCallStatusUpdate>;
  };
}
/** The status lines of a session's running tool calls. */
export const TOOL_CALL_STATUS_METHOD_DESCRIPTORS: ToolCallStatusMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "agent.toolCall.status.subscribe": /* @__PURE__ */ Object.freeze({
      method: "agent.toolCall.status.subscribe",
      procedureType: "subscription",
      mutating: false,
      requestCheck: validateAgentToolCallStatusSubscribeRequest,
      responseCheck: validateSubscribeAcknowledgmentResponse,
      emissionCheck: validateToolCallStatusUpdate,
    }),
  });
