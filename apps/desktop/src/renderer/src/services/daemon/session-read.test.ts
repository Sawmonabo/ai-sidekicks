// The base state a store opens on: the daemon's `session.read`, answered or refused.

import { describe, expect, it } from "vitest";
import { bridgeAnswering } from "@test/helpers/fixture-bridge.js";
import { CONCURRENT_STREAMING_SCENARIO } from "@fixtures/scenarios/concurrent-streaming.js";
import { RefusalError } from "@renderer/lib/refusal.js";
import { sessionReadThroughDaemon } from "./session-read.js";

describe("sessionReadThroughDaemon — the base state a store opens on", () => {
  it("opens at the bottom of the stream and carries the daemon's cursor block unread", async () => {
    const { bridge } = bridgeAnswering((_call, passThrough) => passThrough());

    const baseState = await sessionReadThroughDaemon(bridge)(
      CONCURRENT_STREAMING_SCENARIO.sessionId,
      [],
      undefined,
    );

    expect(baseState).toStrictEqual({
      cursor: 0,
      entities: [],
      timelineCursors: { latest: "concurrent-streaming-cursor-45" },
    });
  });

  it("raises the refusal instead of reading nothing", async () => {
    const { bridge } = bridgeAnswering(() =>
      Promise.reject({ code: "session.not_found", message: "gone" }),
    );

    await expect(
      sessionReadThroughDaemon(bridge)(CONCURRENT_STREAMING_SCENARIO.sessionId, [], undefined),
    ).rejects.toBeInstanceOf(RefusalError);
  });
});
