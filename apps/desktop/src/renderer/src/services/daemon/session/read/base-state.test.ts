// The base state a store opens on: the daemon's `session.read`, then the `transcript.read` window
// at the position the opening picks, passing over a refused one; or for a repair the record alone,
// the stream reopened where the repair says; or refused.

import { encodeEventCursor, START_OF_LOG_POSITION } from "@ai-sidekicks/contracts/session/event-cursor";
import type { SessionReadResponse } from "@ai-sidekicks/contracts/session/methods";
import { describe, expect, it } from "vitest";

import { bridgeAnswering, lastScriptedBeatMs } from "#test/helpers/fixture/bridge.js";
import type { Scenario } from "#fixtures/scenario.js";
import { CONCURRENT_STREAMING_SCENARIO } from "#fixtures/scenarios/concurrent-streaming.js";
import { TRANSCRIPT_STATES_SCENARIO } from "#fixtures/scenarios/transcript-states.js";
import { RefusalError } from "#renderer/lib/refusal/contract.js";
import type { SessionWindowOpening } from "#renderer/store/session/open/entry.js";
import type { RepairReopening, SessionBaseState } from "#renderer/store/session/state.js";
import { sessionReadThroughDaemon } from "./base-state.js";

/** The cursor block a `session.read` reply carries. */
type CursorBlock = SessionReadResponse["transcriptCursors"];

/** The row count every read here asks for, fewer than either scenario's log holds. */
const PAGE_LIMIT = 5;

/** A window opening with no refused position. */
const RESUME: SessionWindowOpening = {
  opensAt: "resume",
  refusedCursor: undefined,
  pageLimit: PAGE_LIMIT,
};

const FLOOR = encodeEventCursor(START_OF_LOG_POSITION);

/**
 * One read through the fixture bridge once the scenario's log is delivered, or before any of it
 * is: the base state, the cursor block the daemon answered with and the window read it asked for.
 */
async function readAt(
  scenario: Scenario,
  opening: SessionWindowOpening,
  isLogDelivered = true,
): Promise<{
  readonly baseState: SessionBaseState | undefined;
  readonly cursors: CursorBlock;
  readonly windowRead: unknown;
}> {
  let daemonReply: unknown;
  const { bridge, calls, engine } = bridgeAnswering(async (call, passThrough) => {
    const reply = await passThrough();
    if (call.method === "session.read") {
      daemonReply = reply;
    }
    return reply;
  }, scenario);
  if (isLogDelivered) {
    engine.advance(lastScriptedBeatMs(scenario) + 1);
  }
  const baseState = await sessionReadThroughDaemon(bridge)(scenario.sessionId, [], opening);
  return {
    baseState,
    cursors: (daemonReply as SessionReadResponse).transcriptCursors,
    windowRead: calls.find((call) => call.method === "transcript.read")?.params,
  };
}

describe("sessionReadThroughDaemon — the base state a store opens on", () => {
  it("opens the window at the acknowledged row and the stream after it", async () => {
    const { baseState, cursors, windowRead } = await readAt(TRANSCRIPT_STATES_SCENARIO, RESUME);

    // The position is relayed as issued and never read for a sequence, which the rows carry.
    expect(cursors.acknowledged).toBeDefined();
    expect(windowRead).toStrictEqual({
      sessionId: TRANSCRIPT_STATES_SCENARIO.sessionId,
      beforeCursor: cursors.acknowledged,
      limit: PAGE_LIMIT,
    });
    const newest = baseState?.transcript?.at(-1);
    expect(newest?.cursor).toBe(cursors.acknowledged);
    expect(baseState).toMatchObject({
      cursor: newest?.sequence,
      entities: [],
      streamAfterCursor: cursors.acknowledged,
      transcriptHead: { hasMore: true },
    });
    expect(baseState?.transcript).toHaveLength(PAGE_LIMIT);
  });

  it("passes a refused acknowledged position over for the newest row, as a snapshot", async () => {
    const { cursors } = await readAt(TRANSCRIPT_STATES_SCENARIO, RESUME);
    const pastAcknowledged = await readAt(TRANSCRIPT_STATES_SCENARIO, {
      ...RESUME,
      refusedCursor: cursors.acknowledged,
    });
    const snapshot = await readAt(TRANSCRIPT_STATES_SCENARIO, { ...RESUME, opensAt: "latest" });

    for (const read of [pastAcknowledged, snapshot]) {
      expect(read.windowRead).toMatchObject({ beforeCursor: cursors.latest });
      expect(read.baseState?.transcript?.at(-1)?.cursor).toBe(cursors.latest);
      expect(read.baseState?.streamAfterCursor).toBe(cursors.latest);
    }
  });

  it("raises a read whose stream could open only at the position the stream refused", async () => {
    const latestCursor = (await readAt(CONCURRENT_STREAMING_SCENARIO, RESUME)).cursors.latest;

    // A refused newest row, and an empty window whose floor was refused.
    await expect(
      readAt(CONCURRENT_STREAMING_SCENARIO, { ...RESUME, refusedCursor: latestCursor }),
    ).rejects.toBeInstanceOf(RefusalError);
    await expect(
      readAt(CONCURRENT_STREAMING_SCENARIO, { ...RESUME, refusedCursor: FLOOR }, false),
    ).rejects.toBeInstanceOf(RefusalError);
    await expect(
      readAt(TRANSCRIPT_STATES_SCENARIO, {
        opensAt: "repair",
        reopening: { from: "head", headCursor: undefined },
        refusedCursor: FLOOR,
      }),
    ).rejects.toBeInstanceOf(RefusalError);
  });

  it("reopens a repair after its row, else before the head, reading only the record", async () => {
    const head = encodeEventCursor(3);
    const lastWholeRow = encodeEventCursor(5);
    const repairFrom = (reopening: RepairReopening): Promise<Awaited<ReturnType<typeof readAt>>> =>
      readAt(TRANSCRIPT_STATES_SCENARIO, {
        opensAt: "repair",
        reopening,
        refusedCursor: undefined,
      });
    const afterRow = await repairFrom({ from: "row", rowCursor: lastWholeRow });
    const atHead = await repairFrom({ from: "head", headCursor: head });
    const atFloor = await repairFrom({ from: "head", headCursor: undefined });

    // The store holds the window's rows, so no window is read.
    for (const read of [afterRow, atHead, atFloor]) {
      expect(read.windowRead).toBeUndefined();
    }
    expect(afterRow.baseState).toStrictEqual({ entities: [], streamAfterCursor: lastWholeRow });
    expect(atHead.baseState).toStrictEqual({ entities: [], streamAfterCursor: head });
    expect(atFloor.cursors.earliest).toBe(FLOOR);
    expect(atFloor.baseState).toStrictEqual({ entities: [], streamAfterCursor: FLOOR });
  });

  it("raises the refusal instead of reading nothing", async () => {
    const { bridge } = bridgeAnswering(() =>
      Promise.reject({ code: "session.not_found", message: "gone" }),
    );

    await expect(
      sessionReadThroughDaemon(bridge)(CONCURRENT_STREAMING_SCENARIO.sessionId, [], RESUME),
    ).rejects.toBeInstanceOf(RefusalError);
  });
});
