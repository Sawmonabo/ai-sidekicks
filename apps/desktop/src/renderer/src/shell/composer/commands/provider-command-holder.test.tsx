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

import type { ProviderCommandListResult } from "@ai-sidekicks/contracts";

import { type ConsoleBridge } from "../../../console/bridge/index.js";
import { bridgeAnswering } from "../../../console/bridge/fixture-bridge.test-support.js";
import { COMPOSER_SCENARIO } from "../../../console/bridge/scenarios/composer.js";
import type { ComposerTarget } from "../chips/chip-models.js";
import { addressedProviderBinding } from "./provider-command-catalog.js";
import {
  ProviderCommandEnumeration,
  useProviderCommandEnumeration,
} from "./provider-command-holder.js";

const ENUMERATION_METHOD = "driver.listProviderCommands";

interface RecordedCall {
  readonly method: string;
  readonly params: unknown;
}

/**
 * The real fixture bridge with a recorder in front of `daemon.call`.
 *
 * The bridge family's own helper rather than a spread of this suite's: the call
 * door's chokepoint gate holds that a test outside `bridge/` stands in for a surface,
 * and a surface goes through the door.
 *
 * `parkedEnumerations`, where a case supplies it, collects a resolver for every
 * enumeration call instead of letting it answer — which is the only way to hold one
 * bridge's reply outstanding across a swap to another bridge and then let it land.
 */
function recordingBridge(
  recorded: RecordedCall[],
  parkedEnumerations?: ((reply: unknown) => void)[],
): ConsoleBridge {
  return bridgeAnswering((call, forward) => {
    recorded.push({ method: call.method, params: call.params });
    if (parkedEnumerations !== undefined && call.method === ENUMERATION_METHOD) {
      return new Promise<unknown>((resolveEnumeration) => {
        parkedEnumerations.push(resolveEnumeration);
      });
    }
    return forward();
  }, COMPOSER_SCENARIO).bridge;
}

/**
 * A reply naming one command, in the registered result shape.
 *
 * Named distinctively so a case can tell WHICH bridge answered rather than only that
 * something did — which is the whole claim when a stale reply lands late.
 */
function enumerationReplyNaming(commandName: string): ProviderCommandListResult {
  const binding = { driverName: "claude", providerAccountId: null };
  return {
    bindings: [
      {
        runId: null,
        binding,
        entries: [{ name: commandName, kind: "command", binding }],
        complete: true,
      },
    ],
  };
}

/**
 * Two agent addresses, distinct and shaped the way the wire requires.
 *
 * `ListProviderCommandsRequest` declares `agentId` a UUID, and the call door parses
 * the REQUEST before it leaves — so an id shaped like a label refuses at the door and
 * every case below would be reading `request-unsendable` instead of the enumeration
 * it means to assert on. What these cases need of the two ids is only that they
 * differ, which is why they are written here rather than borrowed from a scenario.
 */
const FIRST_AGENT = "019b7a11-1100-7a6e-8110-ada11a5a3301";
const SECOND_AGENT = "019b7a11-1100-7a6e-8110-ada11a5a3302";

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

/**
 * The binding the send path's lookup is scoped to.
 *
 * Derived from the same target the hook is driven with rather than written out, so a
 * case cannot accidentally look up under a binding its own composer is not addressed
 * to — which is the thing the lookup is being held to.
 */
const ADDRESSED = addressedProviderBinding(targetForAgent(FIRST_AGENT));

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
        target: targetForAgent(FIRST_AGENT),
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
        target: targetForAgent(FIRST_AGENT),
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
      FIRST_AGENT,
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
      { initialProps: FIRST_AGENT },
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.phase).toBe("served");

    rerender(SECOND_AGENT);

    // Discarded the instant the address changed: the previous agent's groups are
    // gone before the new read has answered.
    expect(result.current.phase).toBe("not-loaded");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      enumerationCalls(recorded).map((entry) => (entry.params as { agentId: string }).agentId),
    ).toEqual([FIRST_AGENT, SECOND_AGENT]);
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
      { initialProps: FIRST_AGENT },
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    rerender(FIRST_AGENT);
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
          target: targetForAgent(FIRST_AGENT),
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
      await Promise.resolve();
      await Promise.resolve();
    });

    const published = enumeration.publishedEntryNamed("compact", ADDRESSED);
    expect(published?.source).toBe("provider");
    expect(published?.name).toBe("compact");
    // A name the provider did not publish stays unnamed, so the send path keeps its
    // own vocabulary for one it has never heard of.
    expect(enumeration.publishedEntryNamed("frame.goToSettings", ADDRESSED)).toBeUndefined();
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
          target: targetForAgent(FIRST_AGENT),
          isOpen,
        }),
      { initialProps: true },
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
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
    const recorded: RecordedCall[] = [];
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
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.phase).toBe("served");

    rerender(secondBridge);

    // Discarded the instant the wire changed, exactly as a re-address discards.
    expect(result.current.phase).toBe("not-loaded");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(enumerationCalls(recorded)).toHaveLength(2);
    expect(result.current.phase).toBe("served");
  });

  it("drops a reply from the bridge that has been replaced", async () => {
    // The second half of the same defect: the outstanding read was guarded by a key
    // the swap did not move, so the old wire's catalog could land ON TOP of the new
    // one's after the surface had already been re-served.
    const recorded: RecordedCall[] = [];
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
      await Promise.resolve();
    });

    rerender(secondBridge);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(enumeration.publishedEntryNamed("compact", ADDRESSED)).toBeDefined();

    // The replaced wire answers only now.
    await act(async () => {
      parkedOnFirstBridge[0]?.(enumerationReplyNaming("only-on-the-replaced-bridge"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      enumeration.publishedEntryNamed("only-on-the-replaced-bridge", ADDRESSED),
    ).toBeUndefined();
    expect(enumeration.publishedEntryNamed("compact", ADDRESSED)).toBeDefined();
  });

  it("negative control: the same bridge at the same address asks nothing a second time", async () => {
    // Without this the two cases above would hold over a holder that re-read on every
    // render, which is a different defect wearing the same green.
    const recorded: RecordedCall[] = [];
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
      await Promise.resolve();
      await Promise.resolve();
    });

    rerender(bridge);
    await act(async () => {
      await Promise.resolve();
    });

    expect(enumerationCalls(recorded)).toHaveLength(1);
  });
});
