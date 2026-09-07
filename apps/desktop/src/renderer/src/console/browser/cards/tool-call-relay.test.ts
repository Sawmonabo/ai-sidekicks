// What the pane still knows once the tool relay's producer has finished.
//
// The defect this pins: a terminal publication carried the reading's kind and nothing
// else, so a stream that relayed calls and then stopped left the feed rendering its
// sentence over an empty list — every invocation the agent had made erased at the
// moment the producer went away. A relayed call is a historical event and stays true
// after the subscription reporting it ends, and BOTH endings are that: an ended arm
// where the producer finished cleanly, and a refused arm where the iterator threw.

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

/**
 * A bridge whose tool relay yields `calls` and then THROWS, which is the second
 * ending: a producer that broke, having already relayed real invocations.
 */
function breakingRelayBridge(calls: readonly RelayedToolCall[]): ConsoleBridge {
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
              throw new Error("the relay stopped mid-stream");
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

async function readingOfKind(
  bridge: ConsoleBridge,
  kind: ToolCallReading["kind"],
): Promise<ToolCallReading> {
  const { result } = renderHook(() => useRelayedToolCalls(bridge, SESSION_ID));
  await waitFor(() => {
    expect(result.current.kind).toBe(kind);
  });
  return result.current;
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

  it("carries the calls it relayed onto the refused arm, beside the relay's failure", async () => {
    // The defect: the exception path replaced the reading with a refusal carrying no
    // calls, so every already-rendered card disappeared even though those historical
    // invocations remain valid.
    const reading = await readingOfKind(
      breakingRelayBridge([relayedCall(1), relayedCall(2)]),
      "refused",
    );
    expect(reading.kind).toBe("refused");
    if (reading.kind !== "refused") {
      return;
    }
    expect(reading.calls.map((call) => call.toolCallId)).toStrictEqual(["call-2", "call-1"]);
    // `beside-an-answer` and not `whole-answer`: the refusal is a note beside two
    // rows on screen rather than the whole of what this window knows.
    expect(reading.scope).toBe("beside-an-answer");
    expect(reading.refusal.code).toBe("tool-relay-failed");
  });

  it("negative control: a relay that broke having relayed nothing IS the whole answer", async () => {
    // Without this the case above would pass over a reading that reported every
    // refusal as `beside-an-answer`, which claims there is something else on screen
    // when there is not — the exact collapse the scope's two members exist to keep
    // apart.
    const reading = await readingOfKind(breakingRelayBridge([]), "refused");
    expect(reading.kind).toBe("refused");
    if (reading.kind !== "refused") {
      return;
    }
    expect(reading.calls).toStrictEqual([]);
    expect(reading.scope).toBe("whole-answer");
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
