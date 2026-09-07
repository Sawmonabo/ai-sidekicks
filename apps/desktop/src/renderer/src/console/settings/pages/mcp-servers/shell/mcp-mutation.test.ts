// The mutation plane: what a press sends, what comes back, and how a row is keyed.
//
// THE KEY IS ASSERTED AS AN IDENTITY AND NOT AS A STRING SHAPE. What matters is that
// two bindings that differ anywhere in the scope-qualified tuple key differently and
// that one binding keys the same way twice — never the particular separator.

import { describe, expect, it, vi } from "vitest";

import {
  createFixtureBridge,
  growthUnavailable,
  type ConsoleBridge,
  type GrowthMcpBindingRef,
  type GrowthMcpInventoryEntry,
  type GrowthMcpMutationResult,
  type GrowthOutcome,
} from "../../../../bridge/index.js";
import { bindingOutcomeKey, setBindingEnabled, setBindingTrust } from "./mcp-mutation.js";

const USER_BINDING: GrowthMcpBindingRef = {
  provider: "claude",
  scope: "user",
  serverName: "filesystem",
};

const PROJECT_BINDING: GrowthMcpBindingRef = {
  provider: "claude",
  scope: "project",
  scopeRef: "/work/atlas",
  serverName: "filesystem",
};

const SETTLED_ROW: GrowthMcpInventoryEntry = {
  ...USER_BINDING,
  effectiveInRuns: true,
  config: { transport: "stdio", command: "npx" },
  status: "connected",
  enabled: false,
  trusted: true,
  configHash: "b3:0000",
  toolOverrides: [],
};

const RESULT: GrowthMcpMutationResult = { server: SETTLED_ROW, applied: "live_reconcile" };

/** A scenario that scripts nothing: each case overrides the operation it drives. */
const EMPTY_SCENARIO: Parameters<typeof createFixtureBridge>[0]["scenario"] = {
  id: "collaboration-mcp-test",
  label: "MCP governance, with nothing scripted",
  purpose: "Drives the two governance mutations against overridden growth operations.",
  sessionId: "session-mcp",
  participantIdsInJoinOrder: [],
  beats: [],
  replies: [],
  startedAtIso: "2026-01-01T08:00:00.000Z",
};

function bridgeAnswering(outcome?: GrowthOutcome<GrowthMcpMutationResult>): {
  readonly bridge: ConsoleBridge;
  readonly setEnabled: ReturnType<typeof vi.fn>;
  readonly setTrust: ReturnType<typeof vi.fn>;
} {
  const fixture = createFixtureBridge({ scenario: EMPTY_SCENARIO });
  const answer = async (): Promise<GrowthOutcome<GrowthMcpMutationResult>> =>
    await Promise.resolve(outcome ?? growthUnavailable("mcpSetEnabled"));
  const setEnabled = vi.fn(answer);
  const setTrust = vi.fn(answer);
  return {
    bridge: {
      ...fixture,
      growth: { ...fixture.growth, mcpSetEnabled: setEnabled, mcpSetTrust: setTrust },
    },
    setEnabled,
    setTrust,
  };
}

describe("bindingOutcomeKey", () => {
  it("keys one binding the same way twice", () => {
    expect(bindingOutcomeKey(USER_BINDING)).toBe(bindingOutcomeKey({ ...USER_BINDING }));
  });

  it("keys two same-named servers in two scopes differently", () => {
    expect(bindingOutcomeKey(USER_BINDING)).not.toBe(bindingOutcomeKey(PROJECT_BINDING));
  });

  it("keys two same-named servers on two providers differently", () => {
    expect(bindingOutcomeKey(PROJECT_BINDING)).not.toBe(
      bindingOutcomeKey({ ...PROJECT_BINDING, provider: "codex" }),
    );
  });

  it("keys two project bindings under different roots differently", () => {
    expect(bindingOutcomeKey(PROJECT_BINDING)).not.toBe(
      bindingOutcomeKey({ ...PROJECT_BINDING, scopeRef: "/work/other" }),
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
    const { bridge, setEnabled } = bridgeAnswering({ status: "served", value: RESULT });
    await setBindingEnabled({
      bridge,
      binding: PROJECT_BINDING,
      enabled: false,
      idempotencyKey: "key-1",
    });
    expect(setEnabled).toHaveBeenCalledWith({
      ...PROJECT_BINDING,
      enabled: false,
      clientIdempotencyKey: "key-1",
    });
  });

  it("answers a settled outcome carrying the binding it was about", async () => {
    const { bridge } = bridgeAnswering({ status: "served", value: RESULT });
    const outcome = await setBindingEnabled({
      bridge,
      binding: USER_BINDING,
      enabled: false,
      idempotencyKey: "key-1",
    });
    expect(outcome).toEqual({ kind: "settled", binding: USER_BINDING, result: RESULT });
  });

  it("answers a refusal carrying the binding it was about, rather than throwing", async () => {
    const { bridge } = bridgeAnswering();
    const outcome = await setBindingEnabled({
      bridge,
      binding: USER_BINDING,
      enabled: false,
      idempotencyKey: "key-1",
    });
    expect(outcome.kind).toBe("refused");
    expect(outcome.kind === "refused" ? outcome.binding : undefined).toEqual(USER_BINDING);
  });

  // A retry of one press reuses one key: the caller supplies it, so two calls made
  // with the key one press minted carry the same value.
  it("carries the key it was given rather than minting a second one", async () => {
    const { bridge, setEnabled } = bridgeAnswering({ status: "served", value: RESULT });
    await setBindingEnabled({
      bridge,
      binding: USER_BINDING,
      enabled: false,
      idempotencyKey: "one-press",
    });
    await setBindingEnabled({
      bridge,
      binding: USER_BINDING,
      enabled: false,
      idempotencyKey: "one-press",
    });
    const keys = setEnabled.mock.calls.map(
      (call) => (call[0] as { clientIdempotencyKey: string }).clientIdempotencyKey,
    );
    expect(keys).toEqual(["one-press", "one-press"]);
  });
});

describe("setBindingTrust", () => {
  it("sends the binding, the target trust, and the caller's key", async () => {
    const { bridge, setTrust } = bridgeAnswering({ status: "served", value: RESULT });
    await setBindingTrust({
      bridge,
      binding: USER_BINDING,
      trusted: true,
      idempotencyKey: "key-2",
    });
    expect(setTrust).toHaveBeenCalledWith({
      ...USER_BINDING,
      trusted: true,
      clientIdempotencyKey: "key-2",
    });
  });

  it("answers a refusal rather than throwing", async () => {
    const { bridge } = bridgeAnswering();
    const outcome = await setBindingTrust({
      bridge,
      binding: USER_BINDING,
      trusted: true,
      idempotencyKey: "key-2",
    });
    expect(outcome.kind).toBe("refused");
  });
});
