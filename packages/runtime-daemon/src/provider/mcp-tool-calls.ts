// The MCP tool-call rules both drivers share: the idempotency floor for a discovered tool, and the
// observation half of the durable task handle, which `./mcp-task-handle-recorder.ts` stores.
//
// - An MCP-discovered tool is always `manual_reconcile_only`, never derived from annotation hints:
//   MCP requires a client to treat annotations as untrusted.
// - The `taskId` in a task-augmented call's `CreateTaskResult` is the handle recovery polls instead
//   of halting. Nothing feeds acceptances here yet: the provider CLIs are the MCP clients, so the
//   daemon does not see a `CreateTaskResult` at dispatch.

import type { IdempotencyClass } from "@ai-sidekicks/contracts";

/** The class of every MCP-discovered tool: equal to a driver's default in value but not in rule. */
export const MCP_DISCOVERED_TOOL_IDEMPOTENCY_CLASS: IdempotencyClass = "manual_reconcile_only";

/**
 * MCP `ToolAnnotations` self-claims, modeled only so {@link classifyMcpDiscoveredTool} can name
 * what it ignores.
 */
export interface McpToolAnnotationHints {
  readonly readOnlyHint?: boolean | undefined;
  readonly idempotentHint?: boolean | undefined;
  readonly destructiveHint?: boolean | undefined;
  readonly openWorldHint?: boolean | undefined;
}

/** Classifies an MCP-discovered tool: always the floor, whatever `annotations` claim. */
export function classifyMcpDiscoveredTool(
  annotations?: McpToolAnnotationHints | undefined,
): IdempotencyClass {
  void annotations;
  return MCP_DISCOVERED_TOOL_IDEMPOTENCY_CLASS;
}

/**
 * The identity of one task-augmented MCP dispatch. `commandId` is the client-supplied idempotency
 * key on the dispatch's `command_receipts` row; `(serverName, toolName)` names no storable row.
 */
export interface McpTaskDispatchIdentity {
  readonly commandId: string;
  readonly serverName: string;
  readonly toolName: string;
}

/** A dispatch whose acceptance carried a receiver-generated `taskId`, ready to be recorded. */
export interface McpTaskHandleObservation extends McpTaskDispatchIdentity {
  readonly mcpTaskId: string;
}

/**
 * Where an observed task handle lands: `McpTaskHandleRecorder.asSink()`, which stores it on the
 * dispatch's `command_receipts` row. Returns `void`: a store failure cannot fail a turn.
 */
export type McpTaskHandleSink = (observation: McpTaskHandleObservation) => void;

/**
 * Extracts `task.taskId` from an untrusted `CreateTaskResult`-shaped acceptance; anything but a
 * non-empty string there yields `undefined`, never an invented handle.
 */
export function extractMcpTaskId(acceptanceResult: unknown): string | undefined {
  if (typeof acceptanceResult !== "object" || acceptanceResult === null) {
    return undefined;
  }
  const task = (acceptanceResult as Record<string, unknown>)["task"];
  if (typeof task !== "object" || task === null) {
    return undefined;
  }
  const taskId = (task as Record<string, unknown>)["taskId"];
  if (typeof taskId !== "string" || taskId.length === 0) {
    return undefined;
  }
  return taskId;
}

/**
 * Hands the sink an observation only when the acceptance carries a handle; otherwise nothing is
 * stored and recovery keeps the floor's halt.
 */
export function observeMcpTaskAcceptance(
  sink: McpTaskHandleSink,
  dispatch: McpTaskDispatchIdentity,
  acceptanceResult: unknown,
): void {
  const mcpTaskId = extractMcpTaskId(acceptanceResult);
  if (mcpTaskId === undefined) {
    return;
  }
  sink({ ...dispatch, mcpTaskId });
}
