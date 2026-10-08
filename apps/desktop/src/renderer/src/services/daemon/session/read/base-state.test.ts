// The base state a store opens on: the daemon's `session.read`, answered at the position the
// opening picks, passing over a refused one, or refused.

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

/** A window opening with no refused position. */
const RESUME: SessionWindowOpening = { opensAt: "resume", refusedCursors: new Set() };

describe("sessionReadThroughDaemon — the base state a store opens on", () => {
  it("opens at the acknowledged position, which heads the window, and the stream after it", async () => {
    const { baseState, cursors } = await readAt(TRANSCRIPT_STATES_SCENARIO, RESUME);

    // The position is relayed as issued and never read for a sequence, which the stream says.
    expect(cursors.acknowledged).toBeDefined();
    expect(baseState).toStrictEqual({
      entities: [],
      streamAfterCursor: cursors.acknowledged,
      readFromCursor: cursors.acknowledged,
    });
  });

  it("passes refused positions over for the floor, and a refused floor for the log's start", async () => {
    const { acknowledged } = (await readAt(TRANSCRIPT_STATES_SCENARIO, RESUME)).cursors;
    if (acknowledged === undefined) {
      throw new Error("The scenario acknowledges a position.");
    }
    const pastAcknowledged = await readAt(TRANSCRIPT_STATES_SCENARIO, {
      opensAt: "resume",
      refusedCursors: new Set([acknowledged]),
    });
    const pastBoth = await readAt(TRANSCRIPT_STATES_SCENARIO, {
      opensAt: "resume",
      refusedCursors: new Set([acknowledged, FLOOR]),
    });
    const pastFloor = await readAt(CONCURRENT_STREAMING_SCENARIO, {
      opensAt: "resume",
      refusedCursors: new Set([FLOOR]),
    });

    expect(pastAcknowledged.cursors.earliest).toBe(FLOOR);
    expect(pastAcknowledged.baseState).toStrictEqual({ entities: [], streamAfterCursor: FLOOR });
    // No position at all: the stream opens with none, from the log's start. Each refusal holds,
    // so a floor refused after the acknowledged position never sends the read back to it.
    expect(pastBoth.baseState).toStrictEqual({ entities: [] });
    expect(pastFloor.baseState).toStrictEqual({ entities: [] });
  });

  it("reopens a repair after the held row it names, else at the window's head", async () => {
    const head = encodeEventCursor(3);
    const lastWholeRow = encodeEventCursor(5);
    const afterRow = await readAt(TRANSCRIPT_STATES_SCENARIO, {
      opensAt: "repair",
      resumeAfterRowCursor: lastWholeRow,
      headCursor: head,
      refusedCursors: new Set(),
    });
    const pastRefusedRow = await readAt(TRANSCRIPT_STATES_SCENARIO, {
      opensAt: "repair",
      resumeAfterRowCursor: lastWholeRow,
      headCursor: head,
      refusedCursors: new Set([lastWholeRow]),
    });
    const atHead = await readAt(TRANSCRIPT_STATES_SCENARIO, {
      opensAt: "repair",
      resumeAfterRowCursor: undefined,
      headCursor: head,
      refusedCursors: new Set(),
    });
    const openedAtFloor = await readAt(TRANSCRIPT_STATES_SCENARIO, {
      opensAt: "repair",
      resumeAfterRowCursor: undefined,
      headCursor: undefined,
      refusedCursors: new Set(),
    });
    const pastRefusedHead = await readAt(TRANSCRIPT_STATES_SCENARIO, {
      opensAt: "repair",
      resumeAfterRowCursor: undefined,
      headCursor: head,
      refusedCursors: new Set([head]),
    });

    // The store holds the window's state at that row, so the stream sends only what follows it.
    expect(afterRow.baseState).toStrictEqual({ entities: [], streamAfterCursor: lastWholeRow });
    // The acknowledged position can sit at or past the newest row the window holds, where the
    // stream would send nothing for the replay to pass.
    expect(atHead.cursors.acknowledged).not.toBe(head);
    const headBase = { entities: [], streamAfterCursor: head, readFromCursor: head };
    expect(atHead.baseState).toStrictEqual(headBase);
    expect(pastRefusedRow.baseState).toStrictEqual(headBase);
    expect(openedAtFloor.baseState).toStrictEqual({ entities: [], streamAfterCursor: FLOOR });
    expect(pastRefusedHead.baseState).toStrictEqual({ entities: [], streamAfterCursor: FLOOR });
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
