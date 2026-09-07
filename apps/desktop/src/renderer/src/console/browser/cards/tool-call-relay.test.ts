// What the pane still knows once the tool relay's producer has finished.
//
// The defect this pins: the terminal publication carried the reading's kind and
// nothing else, so a stream that relayed calls and then closed cleanly left the feed
// rendering "Relay finished" over an empty list — every invocation the agent had made
// erased at the one moment nothing had gone wrong. A relayed call is a historical
// event and stays true after the subscription reporting it ends.

import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { BROWSER_SCENARIO } from "../../bridge/scenarios/browser.js";
import { RELAYED_TOOL_CALL_ROW_CAP } from "../../core/index.js";
import {
  useRelayedToolCalls,
  type RelayedToolCall,
  type ToolCallReading,
} from "./tool-call-relay.js";

const SESSION_ID = BROWSER_SCENARIO.sessionId;

/** One relayed invocation, numbered so a case can name which one it expects. */
function relayedCall(ordinal: number): RelayedToolCall {
  return {
    toolCallId: `call-${ordinal}`,
    toolName: "browser_navigate",
    argumentsJson: `{"url":"https://example.invalid/${ordinal}"}`,
    owningRunLabel: "Run 1",
  };
}

/**
 * A bridge whose tool relay yields `calls` and then ENDS, which is the moment under
 * test: a generator that returns is a producer that finished cleanly.
 */
function endingRelayBridge(calls: readonly RelayedToolCall[]): ConsoleBridge {
  const base = createFixtureBridge({ scenario: BROWSER_SCENARIO });
  return {
    ...base,
    growth: {
      ...base.growth,
      browserSubscribeToolCalls: async () => ({
        status: "served" as const,
        value: {
          events: {
            async *[Symbol.asyncIterator](): AsyncGenerator<RelayedToolCall> {
              yield* calls;
            },
          },
          close: () => {
            // The reading closes its own stream; nothing here needs to observe it.
          },
        },
      }),
    },
  };
}

async function endedReading(calls: readonly RelayedToolCall[]): Promise<ToolCallReading> {
  // Built ONCE, outside the render body: the reading is scoped to the bridge it was
  // opened against, so a fresh bridge per render re-seeds the holder and re-opens the
  // subscription on every pass — a reading that never settles.
  const bridge = endingRelayBridge(calls);
  const { result } = renderHook(() => useRelayedToolCalls(bridge, SESSION_ID));
  await waitFor(() => {
    expect(result.current.kind).toBe("ended");
  });
  return result.current;
}

describe("the pane's tool-call relay", () => {
  it("carries the calls it relayed onto the ended arm", async () => {
    const relayed = [relayedCall(1), relayedCall(2), relayedCall(3)];
    const reading = await endedReading(relayed);
    expect(reading.kind).toBe("ended");
    if (reading.kind !== "ended") {
      return;
    }
    // Newest first, which is the order the live arm publishes in and the order the
    // feed renders: the end changes what may still arrive, never the ordering.
    expect(reading.calls.map((call) => call.toolCallId)).toStrictEqual([
      "call-3",
      "call-2",
      "call-1",
    ]);
  });

  it("keeps the display bound on the ended arm, exactly as the live arm does", async () => {
    const overflowing = Array.from({ length: RELAYED_TOOL_CALL_ROW_CAP + 4 }, (_unused, index) =>
      relayedCall(index + 1),
    );
    const reading = await endedReading(overflowing);
    expect(reading.kind).toBe("ended");
    if (reading.kind !== "ended") {
      return;
    }
    expect(reading.calls).toHaveLength(RELAYED_TOOL_CALL_ROW_CAP);
    expect(reading.calls[0]?.toolCallId).toBe(`call-${String(overflowing.length)}`);
  });

  it("negative control: a producer that relayed nothing ends with an empty list", async () => {
    // Without this the case above would pass over a reading that simply never
    // cleared, and "carries what it relayed" would be indistinguishable from "carries
    // whatever it last held".
    const reading = await endedReading([]);
    expect(reading.kind).toBe("ended");
    if (reading.kind !== "ended") {
      return;
    }
    expect(reading.calls).toStrictEqual([]);
  });
});
