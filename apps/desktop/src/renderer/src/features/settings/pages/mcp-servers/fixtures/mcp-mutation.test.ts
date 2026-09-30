// The MCP mutation calls: what a press sends and what comes back.

import { describe, expect, it, vi, type Mock } from "vitest";

import type {
  McpMutationResult,
  McpServerBindingRef,
  McpServerInventoryEntry,
} from "@ai-sidekicks/contracts";

import { setBindingEnabled, setBindingTrust } from "./mcp-mutation.js";

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
  effectiveInRuns: true,
  config: { transport: "stdio", command: "npx" },
  status: "connected",
  enabled: false,
  trusted: true,
  configHash: "b3:0000",
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

  // A retry of one press reuses one key: the caller supplies it, so two calls made
  // with the key one press minted carry the same value.
  it("carries the key it was given rather than minting a second one", async () => {
    const send = sendAnswering();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await setBindingEnabled({
        send,
        binding: USER_BINDING,
        enabled: false,
        idempotencyKey: "one-press",
      });
    }
    const keys = send.mock.calls.map(
      (call) => (call[0] as { clientIdempotencyKey: string }).clientIdempotencyKey,
    );
    expect(keys).toEqual(["one-press", "one-press"]);
  });
});

describe("setBindingTrust", () => {
  it("sends the binding, the target trust, and the caller's key", async () => {
    const send = sendAnswering();
    await setBindingTrust({ send, binding: USER_BINDING, trusted: true, idempotencyKey: "key-2" });
    expect(send).toHaveBeenCalledWith({
      ...USER_BINDING,
      trusted: true,
      clientIdempotencyKey: "key-2",
    });
  });
});
