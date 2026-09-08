// The two seams the form declares and does not hold, driven the way a host holds them.
//
// WHAT IS WORTH A SUITE HERE is not that a catalog can be read or that a mutation can
// be sent — both have homes with suites of their own. It is that a host outside the
// agent console gets the SAME two properties that console gets: a catalog reading with
// a way back from a refusal, and a latch that admits one round per subject and drops a
// settlement whose subject has moved. Each is a defect the composer would otherwise
// have re-introduced by composing the parts again.
//
// Driven through the real fixture bridge and the real reads, because a stand-in for
// either would be the suite asserting against its own copy of the thing under test.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  createFixtureBridge,
  growthUnavailable,
  type AgentConfigUpdateReading,
  type ConsoleBridge,
  type GrowthOutcome,
} from "../../bridge/index.js";
import {
  fixtureBridgeWithGrowth,
  withDaemonCall,
} from "../../bridge/fixture/fixture-bridge.test-support.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { AGENTS_SCENARIO } from "../../bridge/scenarios/agents.js";
import { settleReads } from "../agent-console/agent-console.test-support.js";
import { useAgentBindingSwitch, useDriverCatalogReading } from "./provider-switch-host.js";

const SESSION_ID = AGENTS_SCENARIO.sessionId;
const AGENT_ID = "agent-scout";

/** The scripted bridge with both catalog calls refused, however many times they are asked. */
function bridgeRefusingCatalog(): {
  readonly bridge: ConsoleBridge;
  readonly attempts: () => number;
} {
  let attempts = 0;
  const under = withDaemonCall(
    createFixtureBridge({ scenario: AGENTS_SCENARIO }),
    async (call, passThrough) => {
      if (!call.method.startsWith("driver.list")) {
        return await passThrough();
      }
      attempts += 1;
      throw new Error("the catalog is unreachable");
    },
  );
  return { bridge: under.bridge, attempts: () => attempts };
}

describe("the driver catalog reaches a second family as a held reading", () => {
  it("serves both catalogs as one loaded reading", async () => {
    const bridge = createFixtureBridge({ scenario: AGENTS_SCENARIO });
    const rendered = renderHook(() => useDriverCatalogReading(bridge));

    await settleReads(bridge);

    const { catalog } = rendered.result.current;
    expect(catalog.kind).toBe("loaded");
    expect(catalog.kind === "loaded" ? catalog.value.models.drivers.length : 0).toBeGreaterThan(0);
  });

  it("offers a way back from a refusal, because nothing on the wire re-arms this read", async () => {
    // The concrete defect: the catalog announces no change anywhere, so a read that
    // failed once is failed for the life of the window unless the host can ask again.
    const { bridge, attempts } = bridgeRefusingCatalog();
    const rendered = renderHook(() => useDriverCatalogReading(bridge));
    await settleReads(bridge);
    expect(rendered.result.current.catalog.kind).toBe("failed");
    const afterFirst = attempts();

    await act(async () => {
      rendered.result.current.reopen();
    });
    await settleReads(bridge);

    expect(attempts()).toBeGreaterThan(afterFirst);
  });

  it("negative control: without that press the refused read asks nothing again", async () => {
    // Without this, the case above would pass over a reading that polled — which is the
    // refresh policy the console's scheduler exists to refuse.
    const { bridge, attempts } = bridgeRefusingCatalog();
    renderHook(() => useDriverCatalogReading(bridge));
    await settleReads(bridge);
    const afterFirst = attempts();

    await settleReads(bridge);
    await settleReads(bridge);

    expect(attempts()).toBe(afterFirst);
  });
});

/** The scripted bridge with `agent.configUpdate` answered by this case, and counted. */
function bridgeAnswering(outcome: GrowthOutcome<AgentConfigUpdateReading> | "reject"): {
  readonly bridge: ConsoleBridge;
  readonly updates: () => number;
} {
  let updates = 0;
  const bridge = fixtureBridgeWithGrowth(AGENTS_SCENARIO, {
    agentConfigUpdate: async () => {
      updates += 1;
      if (outcome === "reject") {
        throw new Error("the daemon refused the move");
      }
      return await Promise.resolve(outcome);
    },
  });
  return { bridge, updates: () => updates };
}

describe("the binding latch admits one round per subject", () => {
  it("submits the move and settles with the reply's own switch", async () => {
    const { bridge, updates } = bridgeAnswering({
      status: "served",
      value: { switch: { status: "pending", switchId: "switch-7" } },
    });
    const rendered = renderHook(() => useAgentBindingSwitch(bridge, SESSION_ID, AGENT_ID));

    await act(async () => {
      rendered.result.current.apply({ modelId: "claude-opus" }, false);
      await crossMacrotaskBoundary();
    });

    expect(updates()).toBe(1);
    expect(rendered.result.current.settlement?.switchId).toBe("switch-7");
    expect(rendered.result.current.isSubmitting).toBe(false);
  });

  it("refuses a second press while the first is outstanding", async () => {
    // The press-twice defect the latch exists to end: the mutation is durable, so two
    // requests are two records of one intended act and two replies racing to decide
    // which settlement is shown.
    const { bridge, updates } = bridgeAnswering({ status: "served", value: {} });
    const rendered = renderHook(() => useAgentBindingSwitch(bridge, SESSION_ID, AGENT_ID));

    act(() => {
      rendered.result.current.apply({ modelId: "claude-opus" }, false);
      rendered.result.current.apply({ modelId: "claude-opus" }, true);
    });

    expect(updates()).toBe(1);
    expect(rendered.result.current.isSubmitting).toBe(true);

    // Let the admitted round land before the case ends, so the settlement it installs
    // is a state change React saw rather than one that arrives after the tree is gone.
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    expect(rendered.result.current.isSubmitting).toBe(false);
  });

  it("carries the refusal under this plane's own origin", async () => {
    const { bridge } = bridgeAnswering("reject");
    const rendered = renderHook(() => useAgentBindingSwitch(bridge, SESSION_ID, AGENT_ID));

    await act(async () => {
      rendered.result.current.apply({ effort: "high" }, false);
      await crossMacrotaskBoundary();
    });

    expect(rendered.result.current.refusal?.origin).toBe("agent-mutation");
    expect(rendered.result.current.refusal?.detail).toContain("the daemon refused the move");
    expect(rendered.result.current.settlement).toBeUndefined();
  });

  it("carries the port's own unavailable arm untouched", async () => {
    // A growth operation the transport does not serve is already a refusal, and
    // re-minting one here would lose the operation and the slate row that owes it.
    const { bridge } = bridgeAnswering(growthUnavailable("agentConfigUpdate"));
    const rendered = renderHook(() => useAgentBindingSwitch(bridge, SESSION_ID, AGENT_ID));

    await act(async () => {
      rendered.result.current.apply({ effort: "high" }, false);
      await crossMacrotaskBoundary();
    });

    expect(rendered.result.current.refusal).not.toBeUndefined();
    expect(rendered.result.current.settlement).toBeUndefined();
  });

  it("drops a settlement once the agent it was submitted for has moved", async () => {
    // A settlement belongs to the subject it was submitted for. Kept across a
    // re-address it would render one agent's answer under another's name, and the
    // latch would still read busy for a subject this surface had left.
    const { bridge } = bridgeAnswering({
      status: "served",
      value: { switch: { status: "pending", switchId: "switch-7" } },
    });
    const rendered = renderHook(
      ({ agentId }: { readonly agentId: string }) =>
        useAgentBindingSwitch(bridge, SESSION_ID, agentId),
      { initialProps: { agentId: AGENT_ID } },
    );
    await act(async () => {
      rendered.result.current.apply({ modelId: "claude-opus" }, false);
      await crossMacrotaskBoundary();
    });
    expect(rendered.result.current.settlement?.switchId).toBe("switch-7");

    await act(async () => {
      rendered.rerender({ agentId: "agent-other" });
    });

    expect(rendered.result.current.settlement).toBeUndefined();
  });

  it("negative control: a host addressed at no agent submits nothing at all", async () => {
    // The hook is still called — a hook may not be called conditionally — and the press
    // has no binding to move, so inventing an id to move one is what this refuses.
    const { bridge, updates } = bridgeAnswering({ status: "served", value: {} });
    const rendered = renderHook(() => useAgentBindingSwitch(bridge, SESSION_ID, undefined));

    await act(async () => {
      rendered.result.current.apply({ modelId: "claude-opus" }, false);
      await crossMacrotaskBoundary();
    });

    expect(updates()).toBe(0);
    expect(rendered.result.current.isSubmitting).toBe(false);
  });
});
