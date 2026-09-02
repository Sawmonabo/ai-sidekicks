// What the console's daemon seam will and will not open.
//
// The two `run.*` streams are session-scoped by their registered request shapes —
// `RunStateSubscribeRequest` and `RunQueueSubscribeRequest` are each
// `z.object({ sessionId }).strict()` — so an open that names no session is a caller
// defect and not a wire event. The wrapper is the structural place to catch it: a
// feed that could spell an unscoped open would still be spelling one the day the
// bridge grows the request channel `Spec-023 §Preload Bridge Contract` pins.
//
// The cases below drive the wrapper directly rather than through a feed, because
// the guard is the wrapper's and a mounted component would put a React tree between
// the assertion and the rule.

import { describe, expect, it } from "vitest";
import {
  RunQueueSubscribeRequestSchema,
  RunStateSubscribeRequestSchema,
} from "@ai-sidekicks/contracts";

import { ConsoleRefusalError } from "../core/index.js";
import type { ConsoleBridge } from "./console-bridge.js";
import {
  DAEMON_STREAM_REFUSAL_ORIGIN,
  QUEUE_SUBSCRIBE_STREAM,
  RUN_STATE_SUBSCRIBE_STREAM,
  subscribeDaemon,
} from "./daemon-calls.js";

const SESSION_ID = "019b7a22-2200-75e5-8510-ada11a5a44a5";

/** A bridge that records which stream name reached `daemon.subscribe`. */
function recordingBridge(): { bridge: ConsoleBridge; openedStreams: string[] } {
  const openedStreams: string[] = [];
  const bridge = {
    sidekicks: {
      daemon: {
        call: async (): Promise<unknown> => undefined,
        subscribe: (event: string) => {
          openedStreams.push(event);
          return () => undefined;
        },
      },
    },
    growth: {},
    growthServedOperations: new Set(),
    source: "fixture",
    scenarioEngine: undefined,
  } as unknown as ConsoleBridge;
  return { bridge, openedStreams };
}

describe("the run streams are opened with their registered request", () => {
  it("opens the run-state stream once its request parses", () => {
    const { bridge, openedStreams } = recordingBridge();
    const request = RunStateSubscribeRequestSchema.parse({ sessionId: SESSION_ID });
    subscribeDaemon(bridge, { method: RUN_STATE_SUBSCRIBE_STREAM, request }, () => undefined);
    expect(openedStreams).toStrictEqual([RUN_STATE_SUBSCRIBE_STREAM]);
  });

  it("opens the queue stream once its request parses", () => {
    const { bridge, openedStreams } = recordingBridge();
    const request = RunQueueSubscribeRequestSchema.parse({ sessionId: SESSION_ID });
    subscribeDaemon(bridge, { method: QUEUE_SUBSCRIBE_STREAM, request }, () => undefined);
    expect(openedStreams).toStrictEqual([QUEUE_SUBSCRIBE_STREAM]);
  });
});

describe("an id-less request refuses at the wrapper", () => {
  it("refuses rather than opening an unscoped subscription", () => {
    const { bridge, openedStreams } = recordingBridge();
    let refused: ConsoleRefusalError | undefined;
    try {
      subscribeDaemon(
        bridge,
        // The shape a caller would reach the wrapper with if it skipped the parse.
        { method: RUN_STATE_SUBSCRIBE_STREAM, request: { sessionId: "" } as never },
        () => undefined,
      );
    } catch (thrown: unknown) {
      refused = thrown as ConsoleRefusalError;
    }
    expect(refused).toBeInstanceOf(ConsoleRefusalError);
    expect(refused?.refusal.origin).toBe(DAEMON_STREAM_REFUSAL_ORIGIN);
    expect(refused?.refusal.code).toBe("stream-request-unscoped");
    // The whole point: the bridge was never reached.
    expect(openedStreams).toStrictEqual([]);
  });

  it("negative control: the same open with a session reaches the bridge", () => {
    // Without this the case above would pass over a wrapper that refused every
    // open, and would prove nothing about the missing session.
    const { bridge, openedStreams } = recordingBridge();
    subscribeDaemon(
      bridge,
      {
        method: RUN_STATE_SUBSCRIBE_STREAM,
        request: RunStateSubscribeRequestSchema.parse({ sessionId: SESSION_ID }),
      },
      () => undefined,
    );
    expect(openedStreams).toStrictEqual([RUN_STATE_SUBSCRIBE_STREAM]);
  });
});
