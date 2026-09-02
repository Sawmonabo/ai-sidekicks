// That re-addressing RE-READS, and never filters the list already in hand.
//
// The rule is the routing invariant expressed as an interaction: an entry enumerated
// under one binding is offerable only in a composer addressed to an agent of that
// same binding. A surface that kept the previous agent's list and narrowed it would
// pass every rendering test and still offer one provider's commands under another's
// address — so the claim is checked where it is decidable, on what was ASKED.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../../console/bridge/index.js";
import { COMPOSER_SCENARIO } from "../../../console/bridge/scenarios/composer.js";
import type { ComposerTarget } from "../chips/chip-models.js";
import { useProviderCommandEnumeration } from "./provider-command-read.js";

const ENUMERATION_METHOD = "driver.listProviderCommands";

interface RecordedCall {
  readonly method: string;
  readonly params: unknown;
}

/** The real fixture bridge with a recorder in front of `daemon.call`. */
function recordingBridge(recorded: RecordedCall[]): ConsoleBridge {
  const base = createFixtureBridge({ scenario: COMPOSER_SCENARIO });
  const call = base.sidekicks.daemon.call as (method: string, params: unknown) => Promise<unknown>;
  return {
    ...base,
    sidekicks: {
      ...base.sidekicks,
      daemon: {
        ...base.sidekicks.daemon,
        call: ((method: string, params: unknown) => {
          recorded.push({ method, params });
          return call(method, params);
        }) as typeof base.sidekicks.daemon.call,
      },
    },
  };
}

function targetForAgent(agentId: string): ComposerTarget {
  return {
    path: "provider-bound",
    sessionId: COMPOSER_SCENARIO.sessionId,
    agentId,
    agentName: undefined,
    driverName: "claude",
    targetRunId: "019b7a11-1100-740e-8110-d1a4c1150311",
    expectedRunVersion: 4,
    runState: "waiting_for_input",
    providerFailureDetail: undefined,
  };
}

function enumerationCalls(recorded: readonly RecordedCall[]): readonly RecordedCall[] {
  return recorded.filter((entry) => entry.method === ENUMERATION_METHOD);
}

describe("useProviderCommandEnumeration", () => {
  it("asks nothing until the discovery surface is open", async () => {
    const recorded: RecordedCall[] = [];
    const bridge = recordingBridge(recorded);
    const { result } = renderHook(() =>
      useProviderCommandEnumeration({
        bridge,
        target: targetForAgent("agent-one"),
        isOpen: false,
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.phase).toBe("not-checked");
    expect(enumerationCalls(recorded)).toHaveLength(0);
  });

  it("reads the addressed agent once the surface opens", async () => {
    const recorded: RecordedCall[] = [];
    const bridge = recordingBridge(recorded);
    const { result } = renderHook(() =>
      useProviderCommandEnumeration({
        bridge,
        target: targetForAgent("agent-one"),
        isOpen: true,
      }),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.phase).toBe("served");
    expect(enumerationCalls(recorded)).toHaveLength(1);
    expect((enumerationCalls(recorded)[0]?.params as { agentId: string }).agentId).toBe(
      "agent-one",
    );
  });

  it("re-reads for a newly addressed agent rather than reusing the list in hand", async () => {
    const recorded: RecordedCall[] = [];
    const bridge = recordingBridge(recorded);
    const { result, rerender } = renderHook(
      (agentId: string) =>
        useProviderCommandEnumeration({
          bridge,
          target: targetForAgent(agentId),
          isOpen: true,
        }),
      { initialProps: "agent-one" },
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.phase).toBe("served");

    rerender("agent-two");

    // Discarded the instant the address changed: the previous agent's groups are
    // gone before the new read has answered.
    expect(result.current.phase).toBe("not-loaded");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      enumerationCalls(recorded).map((entry) => (entry.params as { agentId: string }).agentId),
    ).toEqual(["agent-one", "agent-two"]);
  });

  it("negative control: re-rendering at the same address asks nothing a second time", async () => {
    const recorded: RecordedCall[] = [];
    const bridge = recordingBridge(recorded);
    const { rerender } = renderHook(
      (agentId: string) =>
        useProviderCommandEnumeration({
          bridge,
          target: targetForAgent(agentId),
          isOpen: true,
        }),
      { initialProps: "agent-one" },
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    rerender("agent-one");
    await act(async () => {
      await Promise.resolve();
    });

    expect(enumerationCalls(recorded)).toHaveLength(1);
  });

  it("asks nothing for a composer addressed at a channel", async () => {
    const recorded: RecordedCall[] = [];
    const bridge = recordingBridge(recorded);
    const { result } = renderHook(() =>
      useProviderCommandEnumeration({
        bridge,
        target: {
          path: "channel-message",
          sessionId: COMPOSER_SCENARIO.sessionId,
          channelId: undefined,
          workspaceId: undefined,
          channelLabel: undefined,
        },
        isOpen: true,
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.phase).toBe("not-checked");
    expect(enumerationCalls(recorded)).toHaveLength(0);
  });
});
