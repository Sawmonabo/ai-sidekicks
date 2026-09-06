// One reading, two readers, and the binding a reading belongs to.
//
// Split along the seam the read module was. Every entry carries the binding it was
// read under, and that binding is part of the reading's identity: a Claude-enumerated
// command is never offered to a Codex agent, so a second reader on the same holder
// gets the same reading and a different bridge is a different one.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type ConsoleBridge } from "../../../console/bridge/index.js";
import {
  ProviderCommandEnumeration,
  useProviderCommandEnumeration,
} from "./provider-command-holder.js";
import {
  ADDRESSED,
  FIRST_AGENT,
  enumerationCalls,
  enumerationReplyNaming,
  recordingBridge,
  targetForAgent,
} from "./provider-command-holder.test-support.js";
import type { RecordedDaemonCall } from "../../../console/bridge/fixture/fixture-bridge.test-support.js";
import { drainMicrotasks } from "../../../console/core/microtask-drain.test-support.js";

describe("ProviderCommandEnumeration — one reading, two readers", () => {
  it("puts one enumeration on the wire for both zones", async () => {
    const recorded: RecordedDaemonCall[] = [];
    const bridge = recordingBridge(recorded);
    const enumeration = new ProviderCommandEnumeration();
    // Two observers of one holder: the popover, which opens the reading, and the
    // send path, which only reads it. On the pre-holder tree each zone owned its own
    // hook and this counted two.
    renderHook(() =>
      useProviderCommandEnumeration({
        enumeration,
        bridge,
        target: targetForAgent(FIRST_AGENT),
        isOpen: true,
      }),
    );
    renderHook(() =>
      useProviderCommandEnumeration({
        enumeration,
        bridge,
        target: targetForAgent(FIRST_AGENT),
        isOpen: true,
      }),
    );
    await act(async () => {
      await drainMicrotasks();
    });

    expect(enumerationCalls(recorded)).toHaveLength(1);
  });

  it("negative control: two holders are two readings and ask twice", async () => {
    const recorded: RecordedDaemonCall[] = [];
    const bridge = recordingBridge(recorded);
    for (const enumeration of [
      new ProviderCommandEnumeration(),
      new ProviderCommandEnumeration(),
    ]) {
      renderHook(() =>
        useProviderCommandEnumeration({
          enumeration,
          bridge,
          target: targetForAgent(FIRST_AGENT),
          isOpen: true,
        }),
      );
    }
    await act(async () => {
      await drainMicrotasks();
    });

    expect(enumerationCalls(recorded)).toHaveLength(2);
  });

  it("names a published entry to a reader that never opened the surface", async () => {
    const recorded: RecordedDaemonCall[] = [];
    const bridge = recordingBridge(recorded);
    const enumeration = new ProviderCommandEnumeration();
    // Nothing is named before the reading lands: the send path says what it said
    // before this holder existed rather than guessing at an answer in flight.
    expect(enumeration.publishedEntryNamed("compact", ADDRESSED)).toBeUndefined();

    renderHook(() =>
      useProviderCommandEnumeration({
        enumeration,
        bridge,
        target: targetForAgent(FIRST_AGENT),
        isOpen: true,
      }),
    );
    await act(async () => {
      await drainMicrotasks();
    });

    const published = enumeration.publishedEntryNamed("compact", ADDRESSED);
    expect(published?.source).toBe("provider");
    expect(published?.name).toBe("compact");
    // A name the provider did not publish stays unnamed, so the send path keeps its
    // own vocabulary for one it has never heard of.
    expect(enumeration.publishedEntryNamed("frame.goToSettings", ADDRESSED)).toBeUndefined();
  });

  it("stops naming entries once the surface that opened the reading closes", async () => {
    const recorded: RecordedDaemonCall[] = [];
    const bridge = recordingBridge(recorded);
    const enumeration = new ProviderCommandEnumeration();
    const { rerender } = renderHook(
      (isOpen: boolean) =>
        useProviderCommandEnumeration({
          enumeration,
          bridge,
          target: targetForAgent(FIRST_AGENT),
          isOpen,
        }),
      { initialProps: true },
    );
    await act(async () => {
      await drainMicrotasks();
    });
    expect(enumeration.publishedEntryNamed("compact", ADDRESSED)).toBeDefined();

    await act(async () => {
      rerender(false);
    });

    // The lifetime ends with the surface: what is left is a reading nobody has, not
    // a list held for the next time somebody types a slash.
    expect(enumeration.snapshot().phase).toBe("not-checked");
    expect(enumeration.publishedEntryNamed("compact", ADDRESSED)).toBeUndefined();
  });
});

describe("ProviderCommandEnumeration — the bridge is part of which binding this is", () => {
  it("re-reads when the bridge is replaced under the same session and agent", async () => {
    // `SidekicksBridgeProvider` can swap its bridge while the composer stays addressed
    // where it was. A key of session and agent alone reads that as "nothing moved" and
    // serves the previous wire's catalog, which is exactly the routing invariant the
    // enumeration exists to keep.
    const recorded: RecordedDaemonCall[] = [];
    const firstBridge = recordingBridge(recorded);
    const secondBridge = recordingBridge(recorded);
    const enumeration = new ProviderCommandEnumeration();
    const { result, rerender } = renderHook(
      (bridge: ConsoleBridge) =>
        useProviderCommandEnumeration({
          enumeration,
          bridge,
          target: targetForAgent(FIRST_AGENT),
          isOpen: true,
        }),
      { initialProps: firstBridge },
    );
    await act(async () => {
      await drainMicrotasks();
    });
    expect(result.current.phase).toBe("served");

    rerender(secondBridge);

    // Discarded the instant the wire changed, exactly as a re-address discards.
    expect(result.current.phase).toBe("not-loaded");
    await act(async () => {
      await drainMicrotasks();
    });
    expect(enumerationCalls(recorded)).toHaveLength(2);
    expect(result.current.phase).toBe("served");
  });

  it("drops a reply from the bridge that has been replaced", async () => {
    // The second half of the same defect: the outstanding read was guarded by a key
    // the swap did not move, so the old wire's catalog could land ON TOP of the new
    // one's after the surface had already been re-served.
    const recorded: RecordedDaemonCall[] = [];
    const parkedOnFirstBridge: ((reply: unknown) => void)[] = [];
    const firstBridge = recordingBridge(recorded, parkedOnFirstBridge);
    const secondBridge = recordingBridge(recorded);
    const enumeration = new ProviderCommandEnumeration();
    const { rerender } = renderHook(
      (bridge: ConsoleBridge) =>
        useProviderCommandEnumeration({
          enumeration,
          bridge,
          target: targetForAgent(FIRST_AGENT),
          isOpen: true,
        }),
      { initialProps: firstBridge },
    );
    await act(async () => {
      await drainMicrotasks();
    });

    rerender(secondBridge);
    await act(async () => {
      await drainMicrotasks();
    });
    expect(enumeration.publishedEntryNamed("compact", ADDRESSED)).toBeDefined();

    // The replaced wire answers only now.
    await act(async () => {
      parkedOnFirstBridge[0]?.(enumerationReplyNaming("only-on-the-replaced-bridge"));
      await drainMicrotasks();
    });

    expect(
      enumeration.publishedEntryNamed("only-on-the-replaced-bridge", ADDRESSED),
    ).toBeUndefined();
    expect(enumeration.publishedEntryNamed("compact", ADDRESSED)).toBeDefined();
  });

  it("negative control: the same bridge at the same address asks nothing a second time", async () => {
    // Without this the two cases above would hold over a holder that re-read on every
    // render, which is a different defect wearing the same green.
    const recorded: RecordedDaemonCall[] = [];
    const bridge = recordingBridge(recorded);
    const enumeration = new ProviderCommandEnumeration();
    const { rerender } = renderHook(
      (bridgeForRender: ConsoleBridge) =>
        useProviderCommandEnumeration({
          enumeration,
          bridge: bridgeForRender,
          target: targetForAgent(FIRST_AGENT),
          isOpen: true,
        }),
      { initialProps: bridge },
    );
    await act(async () => {
      await drainMicrotasks();
    });

    rerender(bridge);
    await act(async () => {
      await drainMicrotasks();
    });

    expect(enumerationCalls(recorded)).toHaveLength(1);
  });
});
