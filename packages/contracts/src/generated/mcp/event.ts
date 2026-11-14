// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The MCP governance stream: the stored events of the `mcpGovernance` category, the live notices of an edit to a binding and of a status change, and the `mcp.subscribe` method that carries them.

import type { SchemaCheck } from "../../schema-check.js";
import { validateSubscribeAcknowledgmentResponse } from "../checks/jsonrpc/streaming.js";
import { validateMcpSubscribeEmission } from "../checks/mcp/event.js";
import { validateEmptyPayload } from "../checks/method-descriptor.js";
import type { EventEnvelope } from "../event/envelope.js";
import type { SubscribeAcknowledgmentResponse } from "../jsonrpc/streaming.js";
import type { EmptyPayload } from "../method-descriptor.js";
import type { McpServerStatusChangedNotice } from "./governance.js";
import type { McpServerConfigChangedNotice } from "./server.js";

/**
 * A stored session event of the `mcpGovernance` category: the event envelope, its `category` held to `mcpGovernance`, and its `type` and `payload` kept as written.
 */
export type McpGovernanceEvent = EventEnvelope & {
  category?: "mcpGovernance";
};
/**
 * One `mcp.subscribe` frame: the live notice of an edit to a binding or of a status change, or a
 * governance event. The stream reads governance events from the sentinel session's log at the
 * subscriber's place and sends each notice's newest value per binding and source (a session's
 * leg, the machine probe, an edit), so it keeps no queue, no cursor and no dropped mark.
 */
export type McpSubscribeEmission =
  | McpServerConfigChangedNotice
  | McpServerStatusChangedNotice
  | McpGovernanceEvent;

export { validateMcpGovernanceEvent, validateMcpSubscribeEmission } from "../checks/mcp/event.js";

/** The methods of {@link MCP_EVENT_METHOD_DESCRIPTORS}, each with its checks. */
export interface McpEventMethodDescriptors {
  readonly "mcp.subscribe": {
    readonly method: "mcp.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<McpSubscribeEmission>;
  };
}
/**
 * `mcp.subscribe`, the MCP governance stream, opened before `mcp.server.list` is read so
 * nothing falls between the two. It reads governance events from the sentinel session's log at
 * the subscriber's place and sends each notice's newest value per binding and source (a
 * session's leg, the machine probe, an edit): no cursor, no dropped mark.
 */
export const MCP_EVENT_METHOD_DESCRIPTORS: McpEventMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "mcp.subscribe": /* @__PURE__ */ Object.freeze({
      method: "mcp.subscribe",
      procedureType: "subscription",
      mutating: false,
      requestCheck: validateEmptyPayload,
      responseCheck: validateSubscribeAcknowledgmentResponse,
      emissionCheck: validateMcpSubscribeEmission,
    }),
  });
