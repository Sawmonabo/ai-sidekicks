// The MCP mutation calls: what a press sends, what comes back, and how a row is keyed.
//
// THE KEY IS ASSERTED AS AN IDENTITY AND NOT AS A STRING SHAPE. What matters is that
// two bindings that differ anywhere in the scope-qualified tuple key differently and
// that one binding keys the same way twice — never the particular separator.

import { describe, expect, it, vi, type Mock } from "vitest";

import type {
  McpMutationResult,
  McpServerBindingRef,
  McpServerInventoryEntry,
} from "@ai-sidekicks/contracts";

import { mcpBindingKeyOf, setBindingEnabled, setBindingTrust } from "./mcp-mutation.js";

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

describe("mcpBindingKeyOf", () => {
  it("keys one binding the same way twice", () => {
    expect(mcpBindingKeyOf(USER_BINDING)).toBe(mcpBindingKeyOf({ ...USER_BINDING }));
  });

  it("keys two same-named servers in two scopes differently", () => {
    expect(mcpBindingKeyOf(USER_BINDING)).not.toBe(mcpBindingKeyOf(PROJECT_BINDING));
  });

  it("keys two same-named servers on two providers differently", () => {
    expect(mcpBindingKeyOf(PROJECT_BINDING)).not.toBe(
      mcpBindingKeyOf({ ...PROJECT_BINDING, provider: "codex" }),
    );
  });

  it("keys two project bindings under different roots differently", () => {
    expect(mcpBindingKeyOf(PROJECT_BINDING)).not.toBe(
      mcpBindingKeyOf({ ...PROJECT_BINDING, scopeRef: "/work/other" }),
    );
  });

  // Both halves of the tuple are free-form wire strings — a checkout path an operator
  // chose and a server name an operator typed — so a separator that either of them may
  // contain is not a separator. Under a space join these two bindings are one key: the
  // rows share a React identity, and whichever mutation settles last writes its outcome
  // onto both controls.
  it("keys two bindings apart when a space moves across the scope/name boundary", () => {
    expect(
      mcpBindingKeyOf({ ...PROJECT_BINDING, scopeRef: "/repo one", serverName: "server" }),
    ).not.toBe(
      mcpBindingKeyOf({ ...PROJECT_BINDING, scopeRef: "/repo", serverName: "one server" }),
    );
  });

  // The `user` arm carries no `scopeRef`, and the encoding says so by carrying one
  // segment fewer rather than by substituting a stand-in value for the member that arm
  // does not have — which is what keeps the two arms apart on their own shape and not
  // on the scope word alone.
  it("keys a user binding apart from a project binding rooted at the empty string", () => {
    expect(mcpBindingKeyOf(USER_BINDING)).not.toBe(
      mcpBindingKeyOf({ ...PROJECT_BINDING, scopeRef: "", serverName: USER_BINDING.serverName }),
    );
  });

  // The negative control for the three above: the server NAME alone is equal across
  // every one of those pairs, so a key built from it would have collapsed them.
  it("does not key on the server name", () => {
    const sharedNames = new Set(
      [USER_BINDING, PROJECT_BINDING, { ...PROJECT_BINDING, provider: "codex" as const }].map(
        (binding) => binding.serverName,
      ),
    );
    expect(sharedNames.size).toBe(1);
  });
});

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
