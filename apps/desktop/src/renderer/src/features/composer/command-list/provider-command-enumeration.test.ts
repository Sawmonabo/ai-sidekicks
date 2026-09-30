// One reading, two readers, and the binding a reading belongs to. A command enumerated under one
// binding is never offered to another agent, so a second reader on the holder gets the same
// reading and a different bridge is a different one.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { ProviderCommandEnumeration } from "./provider-command-enumeration.js";
import { useProviderCommandEnumeration } from "./hooks/useProviderCommandEnumeration.js";
import {
  ADDRESSED,
  FIRST_AGENT,
  enumerationCalls,
  enumerationReplyNaming,
  recordingBridge,
  targetForAgent,
} from "./provider-command-enumeration.test-support.js";
import type { RecordedDaemonCall } from "@test/helpers/fixture-bridge.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { WAITING_FOR_INPUT_SCENARIO } from "../../../../../../fixtures/scenarios/waiting-for-input.js";
import { settleEnumeration } from "./provider-command-read.js";

describe("ProviderCommandEnumeration — one reading, two readers", () => {
  it("puts one enumeration on the wire for both zones", async () => {
    const recorded: RecordedDaemonCall[] = [];
    const bridge = recordingBridge(recorded);
    const enumeration = new ProviderCommandEnumeration();
    // Two observers of one holder: the popover opens the reading, the send path only reads it.
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
      await crossMacrotaskBoundary();
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
      await crossMacrotaskBoundary();
    });

    expect(enumerationCalls(recorded)).toHaveLength(2);
  });

  it("names a published entry to a reader that never opened the command list", async () => {
    const recorded: RecordedDaemonCall[] = [];
    const bridge = recordingBridge(recorded);
    const enumeration = new ProviderCommandEnumeration();
    // Nothing is named before the reading lands, so the send path keeps its own answer.
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
      await crossMacrotaskBoundary();
    });

    const published = enumeration.publishedEntryNamed("compact", ADDRESSED);
    expect(published?.source).toBe("provider");
    expect(published?.name).toBe("compact");
    // A name the provider did not publish stays unnamed.
    expect(enumeration.publishedEntryNamed("frame.goToSettings", ADDRESSED)).toBeUndefined();
  });

  it("stops naming entries once the command list that opened the reading closes", async () => {
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
      await crossMacrotaskBoundary();
    });
    expect(enumeration.publishedEntryNamed("compact", ADDRESSED)).toBeDefined();

    await act(async () => {
      rerender(false);
    });

    // The lifetime ends with the command list; nothing is held for the next slash.
    expect(enumeration.snapshot().phase).toBe("not-checked");
    expect(enumeration.publishedEntryNamed("compact", ADDRESSED)).toBeUndefined();
  });
});

describe("ProviderCommandEnumeration — the bridge is part of which binding this is", () => {
  it("re-reads when the bridge is replaced under the same session and agent", async () => {
    // The bridge can be swapped while the composer stays addressed where it was; a key of
    // session and agent alone would serve the previous wire's catalog.
    const recorded: RecordedDaemonCall[] = [];
    const firstBridge = recordingBridge(recorded);
    const secondBridge = recordingBridge(recorded);
    const enumeration = new ProviderCommandEnumeration();
    const { result, rerender } = renderHook(
      (bridge: PlatformBridge) =>
        useProviderCommandEnumeration({
          enumeration,
          bridge,
          target: targetForAgent(FIRST_AGENT),
          isOpen: true,
        }),
      { initialProps: firstBridge },
    );
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    expect(result.current.phase).toBe("served");

    rerender(secondBridge);

    expect(result.current.phase).toBe("not-loaded");
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    expect(enumerationCalls(recorded)).toHaveLength(2);
    expect(result.current.phase).toBe("served");
  });

  it("drops a reply from the bridge that has been replaced", async () => {
    // The outstanding read was guarded by a key the swap did not move, so the old wire's catalog
    // could land on top of the new one's.
    const recorded: RecordedDaemonCall[] = [];
    const parkedOnFirstBridge: ((reply: unknown) => void)[] = [];
    const firstBridge = recordingBridge(recorded, parkedOnFirstBridge);
    const secondBridge = recordingBridge(recorded);
    const enumeration = new ProviderCommandEnumeration();
    const { rerender } = renderHook(
      (bridge: PlatformBridge) =>
        useProviderCommandEnumeration({
          enumeration,
          bridge,
          target: targetForAgent(FIRST_AGENT),
          isOpen: true,
        }),
      { initialProps: firstBridge },
    );
    await act(async () => {
      await crossMacrotaskBoundary();
    });

    rerender(secondBridge);
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    expect(enumeration.publishedEntryNamed("compact", ADDRESSED)).toBeDefined();

    await act(async () => {
      parkedOnFirstBridge[0]?.(enumerationReplyNaming("only-on-the-replaced-bridge"));
      await crossMacrotaskBoundary();
    });

    expect(
      enumeration.publishedEntryNamed("only-on-the-replaced-bridge", ADDRESSED),
    ).toBeUndefined();
    expect(enumeration.publishedEntryNamed("compact", ADDRESSED)).toBeDefined();
  });

  it("negative control: the same bridge at the same address asks nothing a second time", async () => {
    const recorded: RecordedDaemonCall[] = [];
    const bridge = recordingBridge(recorded);
    const enumeration = new ProviderCommandEnumeration();
    const { rerender } = renderHook(
      (bridgeForRender: PlatformBridge) =>
        useProviderCommandEnumeration({
          enumeration,
          bridge: bridgeForRender,
          target: targetForAgent(FIRST_AGENT),
          isOpen: true,
        }),
      { initialProps: bridge },
    );
    await act(async () => {
      await crossMacrotaskBoundary();
    });

    rerender(bridge);
    await act(async () => {
      await crossMacrotaskBoundary();
    });

    expect(enumerationCalls(recorded)).toHaveLength(1);
  });
});

/** The read ends with the command list that opened it: its round's signal reaches `callDaemon`. */
describe("settleEnumeration — the round's signal reaches callDaemon", () => {
  it("puts nothing on the wire for a line that is already over", async () => {
    const recorded: RecordedDaemonCall[] = [];
    const bridge = recordingBridge(recorded);
    const overLine = new AbortController();
    overLine.abort();

    const settled = await settleEnumeration(
      bridge,
      WAITING_FOR_INPUT_SCENARIO.sessionId,
      FIRST_AGENT,
      overLine.signal,
    );

    // `callDaemon`'s pre-send guard is reachable only if the signal was passed, so an empty record
    // is the evidence.
    expect(enumerationCalls(recorded)).toHaveLength(0);
    expect(settled.phase === "refused" ? settled.refusal.code : undefined).toBe("read-abandoned");
  });

  it("negative control: the same read on a live line asks and is served", async () => {
    const recorded: RecordedDaemonCall[] = [];
    const bridge = recordingBridge(recorded);
    const liveLine = new AbortController();

    const settled = await settleEnumeration(
      bridge,
      WAITING_FOR_INPUT_SCENARIO.sessionId,
      FIRST_AGENT,
      liveLine.signal,
    );

    expect(settled.phase).toBe("served");
    expect(enumerationCalls(recorded)).toHaveLength(1);
  });
});

describe("ProviderCommandEnumeration — closing ends the read in flight", () => {
  it("drops a reply that lands after the command list closed", async () => {
    const recorded: RecordedDaemonCall[] = [];
    const parkedWhileTheListIsOpen: ((reply: unknown) => void)[] = [];
    const bridge = recordingBridge(recorded, parkedWhileTheListIsOpen);
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
      await crossMacrotaskBoundary();
    });
    expect(enumerationCalls(recorded)).toHaveLength(1);
    expect(enumeration.snapshot().phase).toBe("not-loaded");

    await act(async () => {
      rerender(false);
    });
    await act(async () => {
      parkedWhileTheListIsOpen[0]?.(enumerationReplyNaming("answered-after-the-close"));
      await crossMacrotaskBoundary();
    });

    expect(enumeration.snapshot().phase).toBe("not-checked");
    expect(enumeration.publishedEntryNamed("answered-after-the-close", ADDRESSED)).toBeUndefined();
  });

  it("negative control: the same held reply lands while the command list is still open", async () => {
    const recorded: RecordedDaemonCall[] = [];
    const parkedWhileTheListIsOpen: ((reply: unknown) => void)[] = [];
    const bridge = recordingBridge(recorded, parkedWhileTheListIsOpen);
    const enumeration = new ProviderCommandEnumeration();
    renderHook(() =>
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

    await act(async () => {
      parkedWhileTheListIsOpen[0]?.(enumerationReplyNaming("answered-while-open"));
      await crossMacrotaskBoundary();
    });

    expect(enumeration.snapshot().phase).toBe("served");
    expect(enumeration.publishedEntryNamed("answered-while-open", ADDRESSED)).toBeDefined();
  });
});
