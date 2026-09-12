// The player, driven against the console's real decode boundary.
//
// The suite deliberately builds its frames as TEXT and never as a `ConsoleSessionEvent`:
// a case that handed the player a typed value would be testing the composer this module
// exists to avoid, and would pass on a console that can no longer read a wire frame.

import { describe, expect, it } from "vitest";

import { IncidentPlayer, composeIncidentScenario } from "./incident-replay.js";
import type { IncidentRecording } from "./incident-recording.js";

const SESSION_ID = "019b7a10-4c00-7d31-9f02-6b1a5e900001";
const USER_YOU = "019b7a10-4c00-79a4-8110-2c40117a0001";

/** One frame the wire does send, as its text. */
function sessionCreatedFrameJson(sequence: number): string {
  return JSON.stringify({
    id: `019b7a10-4c00-7ea1-8110-e5e0d115000${String(sequence)}`,
    sessionId: SESSION_ID,
    sequence,
    occurredAt: "2026-01-14T11:20:00.000Z",
    category: "session_lifecycle",
    type: "session.created",
    actor: USER_YOU,
    payload: { sessionId: SESSION_ID, config: {}, metadata: {} },
    version: "1.0",
  });
}

function recordingOf(frameTexts: readonly string[]): IncidentRecording {
  return {
    incidentId: "player-under-test",
    summary: "A recording standing in for one taken off a live session.",
    recordedAtIso: "2026-01-14T11:20:00.000Z",
    deltas: frameTexts.map((frameJson, index) => ({ atMs: index * 400, frameJson })),
  };
}

/** The scenario members a composition needs, none of which a recording carries. */
const SHAPE_UNDER_TEST = {
  id: "incident-under-test",
  label: "Incident under test",
  purpose: "A composition standing in for a seeded incident.",
  sessionId: SESSION_ID,
  userIdsInJoinOrder: [USER_YOU],
  callerUserId: USER_YOU,
  startedAtIso: "2026-01-14T11:20:00.000Z",
  replies: [],
} as const;

describe("the player reads a recording back through the console's own boundary", () => {
  it("turns each recorded frame into the event the console would hold", () => {
    const player = new IncidentPlayer(recordingOf([sessionCreatedFrameJson(1)]));

    expect(player.refusals).toStrictEqual([]);
    expect(player.beats).toStrictEqual([
      {
        atMs: 0,
        event: {
          id: "019b7a10-4c00-7ea1-8110-e5e0d1150001",
          sessionId: SESSION_ID,
          sequence: 1,
          kind: "session.created",
          occurredAt: "2026-01-14T11:20:00.000Z",
          actorId: USER_YOU,
          payload: { sessionId: SESSION_ID, config: {}, metadata: {} },
        },
      },
    ]);
  });

  it("keeps the recording it was built from", () => {
    const recording = recordingOf([sessionCreatedFrameJson(1)]);

    expect(new IncidentPlayer(recording).recording).toBe(recording);
  });
});

describe("the two ways a recorded frame does not read back", () => {
  it("refuses text that is not JSON, naming the delta", () => {
    const player = new IncidentPlayer(recordingOf(["{not json"]));

    expect(player.beats).toStrictEqual([]);
    expect(player.refusals).toHaveLength(1);
    expect(player.refusals[0]?.deltaIndex).toBe(0);
    expect(player.refusals[0]?.reason).toContain("not JSON");
  });

  it("refuses a frame the decode boundary will not admit", () => {
    // A category the census does not register for this type — the exact disagreement
    // `readConsoleSessionEvent` refuses, and one no fixture-composed beat can reach.
    const misCategorised = JSON.stringify({
      ...(JSON.parse(sessionCreatedFrameJson(1)) as Record<string, unknown>),
      category: "tool_activity",
    });

    const player = new IncidentPlayer(recordingOf([misCategorised]));

    expect(player.beats).toStrictEqual([]);
    expect(player.refusals[0]?.reason).toContain("decode boundary refused it");
  });

  it("negative control: the same frame with its registered category replays", () => {
    const player = new IncidentPlayer(recordingOf([sessionCreatedFrameJson(1)]));

    expect(player.refusals).toStrictEqual([]);
  });
});

describe("composing a scenario from a recording", () => {
  it("carries the recorded beats onto the shape the caller states", () => {
    const scenario = composeIncidentScenario(
      recordingOf([sessionCreatedFrameJson(1), sessionCreatedFrameJson(2)]),
      SHAPE_UNDER_TEST,
    );

    expect(scenario.id).toBe("incident-under-test");
    expect(scenario.beats.map((beat) => beat.atMs)).toStrictEqual([0, 400]);
  });

  it("throws rather than shipping a script the recording no longer supports", () => {
    expect(() =>
      composeIncidentScenario(
        recordingOf([sessionCreatedFrameJson(1), "{not json"]),
        SHAPE_UNDER_TEST,
      ),
    ).toThrow(/delta 1/);
  });

  it("negative control: the same two frames both readable compose without throwing", () => {
    expect(() =>
      composeIncidentScenario(
        recordingOf([sessionCreatedFrameJson(1), sessionCreatedFrameJson(2)]),
        SHAPE_UNDER_TEST,
      ),
    ).not.toThrow();
  });
});
