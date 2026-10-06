// The durable MCP task handle is observed only from a well-formed acceptance.

import { describe, expect, it } from "vitest";

import {
  extractMcpTaskId,
  observeMcpTaskAcceptance,
  type McpTaskHandleObservation,
} from "../tool-calls.js";

describe("durable MCP task-handle observation", () => {
  it("yields undefined for every non-acceptance shape (the halt default)", () => {
    expect(extractMcpTaskId(undefined)).toBeUndefined();
    expect(extractMcpTaskId(null)).toBeUndefined();
    expect(extractMcpTaskId({})).toBeUndefined();
    expect(extractMcpTaskId({ task: {} })).toBeUndefined();
    expect(extractMcpTaskId({ task: { taskId: "" } })).toBeUndefined();
    expect(extractMcpTaskId({ task: { taskId: 7 } })).toBeUndefined();
  });

  it("hands the sink the dispatch identity with the handle, and nothing otherwise", () => {
    // `commandId` reaches the sink verbatim: it names the `command_receipts` row the handle is
    // written to, which the MCP server and tool names cannot. A dispatch without a handle calls
    // nothing, so the column stays NULL and after a restart the call stays halted.
    const observations: McpTaskHandleObservation[] = [];
    const collectingSink = (observation: McpTaskHandleObservation): void => {
      observations.push(observation);
    };
    const dispatch = {
      commandId: "command-7",
      serverName: "filesystem",
      toolName: "read_file",
    } as const;
    observeMcpTaskAcceptance(collectingSink, dispatch, { task: { taskId: "task-9" } });
    observeMcpTaskAcceptance(collectingSink, dispatch, { task: {} });
    expect(observations).toEqual([
      {
        commandId: "command-7",
        serverName: "filesystem",
        toolName: "read_file",
        mcpTaskId: "task-9",
      },
    ]);
  });
});
