// The MCP mutation calls: what a press sends and what comes back.

import { describe, expect, it, vi, type Mock } from "vitest";

import type {
  McpMutationResult,
  McpServerBindingRef,
  McpServerInventoryEntry,
} from "@ai-sidekicks/contracts";

import { setBindingEnabled } from "./mcp-mutation.js";

const USER_BINDING: McpServerBindingRef = {
  provider: "claude",
  scope: "user",
  serverName: "filesystem",
};

const PROJECT_BINDING: McpServerBindingRef = {
  provider: "claude",
  scope: "project",
  scopeRef: "/work/atlas",
  serverName: "filesystem",
};

const SETTLED_ROW: McpServerInventoryEntry = {
  ...USER_BINDING,
  config: { transport: "stdio", command: "npx" },
  status: "connected",
  enabled: false,
  toolOverrides: [],
};

const RESULT: McpMutationResult = { server: SETTLED_ROW, applied: "live_reconcile" };

function sendAnswering(): Mock<(request: unknown) => Promise<McpMutationResult>> {
  return vi.fn(async () => await Promise.resolve(RESULT));
}

describe("setBindingEnabled", () => {
  it("sends the binding, the target state, and the caller's key", async () => {
    const send = sendAnswering();
    await setBindingEnabled({
      send,
      binding: PROJECT_BINDING,
      enabled: false,
      idempotencyKey: "key-1",
    });
    expect(send).toHaveBeenCalledWith({
      ...PROJECT_BINDING,
      enabled: false,
      clientIdempotencyKey: "key-1",
    });
  });

  it("answers a settled outcome carrying the binding it was about", async () => {
    const outcome = await setBindingEnabled({
      send: sendAnswering(),
      binding: USER_BINDING,
      enabled: false,
      idempotencyKey: "key-1",
    });
    expect(outcome).toEqual({ kind: "settled", binding: USER_BINDING, result: RESULT });
  });
});
