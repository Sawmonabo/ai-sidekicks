// The base state a store opens on: the daemon's `session.read`, answered at the position the
// resume rule picks, passing over a refused one, or refused.

import { encodeEventCursor, START_OF_LOG_POSITION } from "@ai-sidekicks/contracts/session/id";
import type { SessionReadResponse } from "@ai-sidekicks/contracts/session/methods";
import { describe, expect, it } from "vitest";

import { bridgeAnswering } from "#test/helpers/fixture/bridge.js";
import type { Scenario } from "#fixtures/scenario.js";
import { CONCURRENT_STREAMING_SCENARIO } from "#fixtures/scenarios/concurrent-streaming.js";
import { TRANSCRIPT_STATES_SCENARIO } from "#fixtures/scenarios/transcript-states.js";
import { RefusalError } from "#renderer/lib/refusal/contract.js";
import type { SessionWindowOpening } from "#renderer/store/session/open/entry.js";
import type { SessionBaseState } from "#renderer/store/session/state.js";
import { sessionReadThroughDaemon } from "./base-state.js";

/** The cursor block a `session.read` reply carries. */
type CursorBlock = SessionReadResponse["transcriptCursors"];

/** One read through the fixture bridge, and the cursor block the daemon answered it with. */
async function readAt(
  scenario: Scenario,
  opening: SessionWindowOpening,
): Promise<{ readonly baseState: SessionBaseState | undefined; readonly cursors: CursorBlock }> {
  let daemonReply: unknown;
  const { bridge } = bridgeAnswering(async (call, passThrough) => {
    const reply = await passThrough();
    if (call.method === "session.read") {
      daemonReply = reply;
    }
    return reply;
  }, scenario);
  const baseState = await sessionReadThroughDaemon(bridge)(scenario.sessionId, [], opening);
  return { baseState, cursors: (daemonReply as SessionReadResponse).transcriptCursors };
}

const FLOOR = encodeEventCursor(START_OF_LOG_POSITION);

describe("sessionReadThroughDaemon — the base state a store opens on", () => {
  it("opens at the acknowledged position, which heads the window, and the stream after it", async () => {
    const { baseState, cursors } = await readAt(TRANSCRIPT_STATES_SCENARIO, {
      refusedCursor: undefined,
    });

    // The position is relayed as issued and never read for a sequence, which the stream says.
    expect(cursors.acknowledged).toBeDefined();
    expect(baseState).toStrictEqual({
      entities: [],
      streamAfterCursor: cursors.acknowledged,
      readFromCursor: cursors.acknowledged,
    });
  });

  it("passes a refused position over for the floor, and a refused floor for the log's start", async () => {
    const { cursors } = await readAt(TRANSCRIPT_STATES_SCENARIO, { refusedCursor: undefined });
    const pastAcknowledged = await readAt(TRANSCRIPT_STATES_SCENARIO, {
      refusedCursor: cursors.acknowledged,
    });
    const pastFloor = await readAt(CONCURRENT_STREAMING_SCENARIO, { refusedCursor: FLOOR });

    expect(pastAcknowledged.cursors.earliest).toBe(FLOOR);
    expect(pastAcknowledged.baseState).toStrictEqual({ entities: [], streamAfterCursor: FLOOR });
    // No position at all: the stream opens with none, from the log's start.
    expect(pastFloor.baseState).toStrictEqual({ entities: [] });
  });

  it("raises the refusal instead of reading nothing", async () => {
    const { bridge } = bridgeAnswering(() =>
      Promise.reject({ code: "session.not_found", message: "gone" }),
    );

    await expect(
      sessionReadThroughDaemon(bridge)(CONCURRENT_STREAMING_SCENARIO.sessionId, [], {
        refusedCursor: undefined,
      }),
    ).rejects.toBeInstanceOf(RefusalError);
  });
});
