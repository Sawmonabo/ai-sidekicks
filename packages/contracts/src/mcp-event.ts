// The MCP governance stream: the session events of the `mcp_governance`
// category, the live notice of an edit to a binding, and the `mcp.subscribe`
// method that carries both. A leaf below `event.ts`, because the MCP contract
// files are imported by `event.ts` and cannot import it back.
import { z } from "zod";

import { MCP_GOVERNANCE_EVENT_TYPES } from "./event-registry.js";
import { SessionEventSchema } from "./event.js";
import type { SessionEvent } from "./event-variant-types.js";
import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "./jsonrpc-streaming.js";
import {
  McpServerConfigChangedNoticeSchema,
  McpSubscribeRequestSchema,
  type McpServerConfigChangedNotice,
  type McpSubscribeRequest,
} from "./mcp.js";
import { defineMethodDescriptors, type SubscriptionMethodDescriptor } from "./method-descriptor.js";

/** A session event of the `mcp_governance` category. */
export type McpGovernanceEvent = Extract<SessionEvent, { category: "mcp_governance" }>;

const MCP_GOVERNANCE_EVENT_TYPE_SET: ReadonlySet<string> = new Set(MCP_GOVERNANCE_EVENT_TYPES);

/** `SessionEventSchema` narrowed to the `mcp_governance` category; any other event is refused. */
export const McpGovernanceEventSchema: z.ZodType<McpGovernanceEvent> =
  SessionEventSchema.superRefine((event, ctx) => {
    if (MCP_GOVERNANCE_EVENT_TYPE_SET.has(event.type)) return;
    ctx.addIssue({
      code: "custom",
      path: ["type"],
      message: `Event type '${event.type}' is not an MCP governance event.`,
    });
  }) as z.ZodType<McpGovernanceEvent>;

/** One `mcp.subscribe` frame: a governance event, or the live notice of an edit. */
export type McpSubscribeEmission = McpGovernanceEvent | McpServerConfigChangedNotice;
/** Parses an {@link McpSubscribeEmission}. */
export const McpSubscribeEmissionSchema: z.ZodType<McpSubscribeEmission> = z.union([
  McpServerConfigChangedNoticeSchema,
  McpGovernanceEventSchema,
]);

/** `mcp.subscribe`: the governance events and edit notices, opened before the list is read. */
export interface McpEventMethodDescriptors {
  readonly "mcp.subscribe": SubscriptionMethodDescriptor<
    "mcp.subscribe",
    McpSubscribeRequest,
    SubscribeAckResponse,
    McpSubscribeEmission
  >;
}

/** The MCP governance stream's method: its name, how it answers, and its shapes. */
export const MCP_EVENT_METHOD_DESCRIPTORS: McpEventMethodDescriptors = defineMethodDescriptors({
  "mcp.subscribe": {
    method: "mcp.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestSchema: McpSubscribeRequestSchema,
    responseSchema: SubscribeAckResponseSchema,
    emissionSchema: McpSubscribeEmissionSchema,
  },
});
