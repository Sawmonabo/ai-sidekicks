// The enumeration hook asks the provider nothing until the command list opens, so a person who
// never types a slash costs no provider round trip.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProviderCommandEnumeration } from "../provider-command-enumeration.js";
import { useProviderCommandEnumeration } from "./useProviderCommandEnumeration.js";
import {
  FIRST_AGENT,
  enumerationCalls,
  recordingBridge,
  targetForAgent,
} from "../provider-command-enumeration.test-support.js";
import { type RecordedDaemonCall } from "@test/helpers/fixture-bridge.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";

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
});
