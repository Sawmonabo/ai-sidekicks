// The base state a store opens on: the daemon's `session.read`, answered or refused.

import { describe, expect, it } from "vitest";
import { bridgeAnswering } from "@test/helpers/fixture/bridge.js";
import { CONCURRENT_STREAMING_SCENARIO } from "@fixtures/scenarios/concurrent-streaming.js";
import { TRANSCRIPT_STATES_SCENARIO } from "@fixtures/scenarios/transcript-states.js";
import { RefusalError } from "@renderer/lib/refusal/refusal.js";
import { sessionReadThroughDaemon } from "./read.js";

describe("sessionReadThroughDaemon — the base state a store opens on", () => {
  it("opens at the bottom of the stream and carries the daemon's cursor block unread", async () => {
    // The daemon's own reply, so the block the store opens on is compared with what was sent; this
    // scenario's block names both the newest row and the acknowledged one.
    let daemonReply: unknown;
    const { bridge } = bridgeAnswering(async (call, passThrough) => {
      const reply = await passThrough();
      if (call.method === "session.read") {
        daemonReply = reply;
      }
      return reply;
    }, TRANSCRIPT_STATES_SCENARIO);

    const baseState = await sessionReadThroughDaemon(bridge)(
      TRANSCRIPT_STATES_SCENARIO.sessionId,
      [],
      undefined,
    );

    const { transcriptCursors } = daemonReply as { transcriptCursors: unknown };
    expect(transcriptCursors).toMatchObject({
      latest: expect.any(String),
      acknowledged: expect.any(String),
    });
    expect(baseState).toStrictEqual({ cursor: 0, entities: [], transcriptCursors });
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
