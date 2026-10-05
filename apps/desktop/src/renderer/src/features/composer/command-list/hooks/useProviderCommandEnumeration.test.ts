// The enumeration hook asks the provider nothing until the command list opens, so a person who
// never types a slash costs no provider round trip, and a newly addressed agent is read again
// rather than served the list in hand.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProviderCommandEnumeration } from "../provider-command/provider-command-enumeration.js";
import { useProviderCommandEnumeration } from "./useProviderCommandEnumeration.js";
import {
  FIRST_AGENT,
  SECOND_AGENT,
  enumerationCalls,
  recordingBridge,
  targetForAgent,
} from "../provider-command/provider-command-enumeration.test-support.js";
import { type RecordedDaemonCall } from "#test/helpers/fixture/bridge.js";
import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";

describe("useProviderCommandEnumeration", () => {
  it("asks nothing until the command list is open", async () => {
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

    // The previous agent's groups are gone before the new read answers.
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
});
