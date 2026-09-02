// One reading, two readers, and a re-address that RE-READS rather than filtering.
//
// Two claims, and both are about what was ASKED rather than about what rendered. The
// first is the routing invariant expressed as an interaction: an entry enumerated
// under one binding is offerable only in a composer addressed to an agent of that
// same binding, so a surface that kept the previous agent's list and narrowed it
// would pass every rendering test and still offer one provider's commands under
// another's address. The second is the arithmetic this holder exists for — the
// popover and the send path observe ONE reading, so opening the surface puts one
// enumeration on the wire and not one per zone.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../../console/bridge/index.js";
import { COMPOSER_SCENARIO } from "../../../console/bridge/scenarios/composer.js";
import type { ComposerTarget } from "../chips/chip-models.js";
import {
  ProviderCommandEnumeration,
  useProviderCommandEnumeration,
} from "./provider-command-holder.js";

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
    const enumeration = new ProviderCommandEnumeration();
    const { result } = renderHook(() =>
      useProviderCommandEnumeration({
        enumeration,
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
    const enumeration = new ProviderCommandEnumeration();
    const { result } = renderHook(() =>
      useProviderCommandEnumeration({
        enumeration,
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
    const enumeration = new ProviderCommandEnumeration();
    const { result, rerender } = renderHook(
      (agentId: string) =>
        useProviderCommandEnumeration({
          enumeration,
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
    const enumeration = new ProviderCommandEnumeration();
    const { rerender } = renderHook(
      (agentId: string) =>
        useProviderCommandEnumeration({
          enumeration,
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
    const enumeration = new ProviderCommandEnumeration();
    const { result } = renderHook(() =>
      useProviderCommandEnumeration({
        enumeration,
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

describe("ProviderCommandEnumeration — one reading, two readers", () => {
  it("puts one enumeration on the wire for both zones", async () => {
    const recorded: RecordedCall[] = [];
    const bridge = recordingBridge(recorded);
    const enumeration = new ProviderCommandEnumeration();
    // Two observers of one holder: the popover, which opens the reading, and the
    // send path, which only reads it. On the pre-holder tree each zone owned its own
    // hook and this counted two.
    renderHook(() =>
      useProviderCommandEnumeration({
        enumeration,
        bridge,
        target: targetForAgent("agent-one"),
        isOpen: true,
      }),
    );
    renderHook(() =>
      useProviderCommandEnumeration({
        enumeration,
        bridge,
        target: targetForAgent("agent-one"),
        isOpen: true,
      }),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(enumerationCalls(recorded)).toHaveLength(1);
  });

  it("negative control: two holders are two readings and ask twice", async () => {
    const recorded: RecordedCall[] = [];
    const bridge = recordingBridge(recorded);
    for (const enumeration of [
      new ProviderCommandEnumeration(),
      new ProviderCommandEnumeration(),
    ]) {
      renderHook(() =>
        useProviderCommandEnumeration({
          enumeration,
          bridge,
          target: targetForAgent("agent-one"),
          isOpen: true,
        }),
      );
    }
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(enumerationCalls(recorded)).toHaveLength(2);
  });

  it("names a published entry to a reader that never opened the surface", async () => {
    const recorded: RecordedCall[] = [];
    const bridge = recordingBridge(recorded);
    const enumeration = new ProviderCommandEnumeration();
    // Nothing is named before the reading lands: the send path says what it said
    // before this holder existed rather than guessing at an answer in flight.
    expect(enumeration.publishedEntryNamed("compact")).toBeUndefined();

    renderHook(() =>
      useProviderCommandEnumeration({
        enumeration,
        bridge,
        target: targetForAgent("agent-one"),
        isOpen: true,
      }),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const published = enumeration.publishedEntryNamed("compact");
    expect(published?.source).toBe("provider");
    expect(published?.name).toBe("compact");
    // A name the provider did not publish stays unnamed, so the send path keeps its
    // own vocabulary for one it has never heard of.
    expect(enumeration.publishedEntryNamed("frame.goToSettings")).toBeUndefined();
  });

  it("stops naming entries once the surface that opened the reading closes", async () => {
    const recorded: RecordedCall[] = [];
    const bridge = recordingBridge(recorded);
    const enumeration = new ProviderCommandEnumeration();
    const { rerender } = renderHook(
      (isOpen: boolean) =>
        useProviderCommandEnumeration({
          enumeration,
          bridge,
          target: targetForAgent("agent-one"),
          isOpen,
        }),
      { initialProps: true },
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(enumeration.publishedEntryNamed("compact")).toBeDefined();

    await act(async () => {
      rerender(false);
    });

    // The lifetime ends with the surface: what is left is a reading nobody has, not
    // a list held for the next time somebody types a slash.
    expect(enumeration.snapshot().phase).toBe("not-checked");
    expect(enumeration.publishedEntryNamed("compact")).toBeUndefined();
  });
});
