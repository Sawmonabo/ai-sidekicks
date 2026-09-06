// The enumeration hook: when it reads, when it does not, and what it hands back.
//
// The surface's own view of the holder. An enumeration is a live read held as
// driver-session state rather than a stored registry, so what this asserts is when a
// read is issued at all and what a reader sees while one is in flight.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { COMPOSER_SCENARIO } from "../../../console/bridge/scenarios/composer.js";
import {
  ProviderCommandEnumeration,
  useProviderCommandEnumeration,
} from "./provider-command-holder.js";
import {
  FIRST_AGENT,
  SECOND_AGENT,
  enumerationCalls,
  recordingBridge,
  targetForAgent,
} from "./provider-command-holder.test-support.js";
import { type RecordedDaemonCall } from "../../../console/bridge/fixture/fixture-bridge.test-support.js";
import { crossMacrotaskBoundary } from "../../../console/core/macrotask-boundary.test-support.js";

describe("useProviderCommandEnumeration", () => {
  it("asks nothing until the discovery surface is open", async () => {
    const recorded: RecordedDaemonCall[] = [];
    const bridge = recordingBridge(recorded);
    const enumeration = new ProviderCommandEnumeration();
    const { result } = renderHook(() =>
      useProviderCommandEnumeration({
        enumeration,
        bridge,
        target: targetForAgent(FIRST_AGENT),
        isOpen: false,
      }),
    );
    await act(async () => {
      await crossMacrotaskBoundary();
    });

    expect(result.current.phase).toBe("not-checked");
    expect(enumerationCalls(recorded)).toHaveLength(0);
  });

  it("reads the addressed agent once the surface opens", async () => {
    const recorded: RecordedDaemonCall[] = [];
    const bridge = recordingBridge(recorded);
    const enumeration = new ProviderCommandEnumeration();
    const { result } = renderHook(() =>
      useProviderCommandEnumeration({
        enumeration,
        bridge,
        target: targetForAgent(FIRST_AGENT),
        isOpen: true,
      }),
    );
    await act(async () => {
      await crossMacrotaskBoundary();
    });

    expect(result.current.phase).toBe("served");
    expect(enumerationCalls(recorded)).toHaveLength(1);
    expect((enumerationCalls(recorded)[0]?.params as { agentId: string }).agentId).toBe(
      FIRST_AGENT,
    );
  });

  it("re-reads for a newly addressed agent rather than reusing the list in hand", async () => {
    const recorded: RecordedDaemonCall[] = [];
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
      { initialProps: FIRST_AGENT },
    );
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    expect(result.current.phase).toBe("served");

    rerender(SECOND_AGENT);

    // Discarded the instant the address changed: the previous agent's groups are
    // gone before the new read has answered.
    expect(result.current.phase).toBe("not-loaded");
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    expect(
      enumerationCalls(recorded).map((entry) => (entry.params as { agentId: string }).agentId),
    ).toEqual([FIRST_AGENT, SECOND_AGENT]);
  });

  it("negative control: re-rendering at the same address asks nothing a second time", async () => {
    const recorded: RecordedDaemonCall[] = [];
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
      { initialProps: FIRST_AGENT },
    );
    await act(async () => {
      await crossMacrotaskBoundary();
    });

    rerender(FIRST_AGENT);
    await act(async () => {
      await crossMacrotaskBoundary();
    });

    expect(enumerationCalls(recorded)).toHaveLength(1);
  });

  it("asks nothing for a composer addressed at a channel", async () => {
    const recorded: RecordedDaemonCall[] = [];
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
      await crossMacrotaskBoundary();
    });

    expect(result.current.phase).toBe("not-checked");
    expect(enumerationCalls(recorded)).toHaveLength(0);
  });
});
