// The seeded incident, held to the recording it was taken from.
//
// This suite is the alarm the `incident` class exists to raise. It reads the recorded
// frames back through the console's own decode boundary, exactly as a delivery would
// cross it, so the day the console stops reading one of them the failure lands here —
// naming the frame — instead of landing in a live session nobody is watching.
//
// **A red case here is never fixed by editing the frames.** They are what arrived.

import { describe, expect, it } from "vitest";

import {
  LEDGER_WINDOW_GROWTH_INCIDENT_SCENARIO,
  LEDGER_WINDOW_GROWTH_INCIDENT_SCENARIO_ID,
  LEDGER_WINDOW_GROWTH_RECORDING,
} from "./ledger-window-growth.js";
import { IncidentPlayer } from "../../scenario-runtime/incident-replay.js";
import { frozenTicksFor } from "../../scenario-runtime/frozen-tick-registry.js";

/** The recorded row count the defect needed: 51 rows against a one-screen window. */
const RECORDED_FRAME_COUNT = 51;

/** What one recorded frame says about itself, read from its own text. */
function frameMembers(frameJson: string): Record<string, unknown> {
  return JSON.parse(frameJson) as Record<string, unknown>;
}

describe("the ledger-window-growth recording", () => {
  it("holds the frames the defect needed, in arrival order", () => {
    expect(LEDGER_WINDOW_GROWTH_RECORDING.deltas).toHaveLength(RECORDED_FRAME_COUNT);

    const ticks = LEDGER_WINDOW_GROWTH_RECORDING.deltas.map((delta) => delta.atMs);

    expect(ticks).toStrictEqual([...ticks].sort((left, right) => left - right));
  });

  it("reads every frame back through the console's decode boundary", () => {
    const player = new IncidentPlayer(LEDGER_WINDOW_GROWTH_RECORDING);

    expect(player.refusals).toStrictEqual([]);
    expect(player.beats).toHaveLength(RECORDED_FRAME_COUNT);
  });

  it("keeps the beats and the recorded bytes the same frames", () => {
    // The claim that makes this a RECORDING: what the scenario plays is what the text
    // says, member for member, rather than anything recomposed on the way through.
    for (const [beatIndex, beat] of LEDGER_WINDOW_GROWTH_INCIDENT_SCENARIO.beats.entries()) {
      const delta = LEDGER_WINDOW_GROWTH_RECORDING.deltas[beatIndex];

      expect(delta).toBeDefined();
      expect(beat.atMs).toBe(delta?.atMs);

      const recorded = frameMembers(delta?.frameJson ?? "{}");

      expect(beat.event.kind).toBe(recorded["type"]);
      expect(beat.event.sequence).toBe(recorded["sequence"]);
      expect(beat.event.id).toBe(recorded["id"]);
      expect(beat.event.actorId).toBe(recorded["actor"]);
    }
  });

  it("negative control: a frame the boundary refuses is reported, not dropped", () => {
    const firstDelta = LEDGER_WINDOW_GROWTH_RECORDING.deltas[0];

    expect(firstDelta).toBeDefined();

    const player = new IncidentPlayer({
      ...LEDGER_WINDOW_GROWTH_RECORDING,
      deltas: [
        {
          atMs: 0,
          frameJson: JSON.stringify({
            ...frameMembers(firstDelta?.frameJson ?? "{}"),
            category: "tool_activity",
          }),
        },
      ],
    });

    expect(player.beats).toStrictEqual([]);
    expect(player.refusals).toHaveLength(1);
  });
});

describe("the session the recording replays as", () => {
  it("opens the log where the store expects a session's first row", () => {
    expect(LEDGER_WINDOW_GROWTH_INCIDENT_SCENARIO.beats[0]?.event.sequence).toBe(1);
    expect(LEDGER_WINDOW_GROWTH_INCIDENT_SCENARIO.beats.at(-1)?.event.sequence).toBe(
      RECORDED_FRAME_COUNT,
    );
  });

  it("carries the four concurrent lanes that produced the growth", () => {
    const runIds = new Set(
      LEDGER_WINDOW_GROWTH_INCIDENT_SCENARIO.beats
        .map((beat) => beat.event.payload?.["runId"])
        .filter((runId): runId is string => typeof runId === "string"),
    );

    expect(runIds.size).toBe(4);
  });

  it("pins the frame the defect was visible in", () => {
    const ticks = frozenTicksFor(LEDGER_WINDOW_GROWTH_INCIDENT_SCENARIO_ID);
    const lastBeatAtMs = LEDGER_WINDOW_GROWTH_INCIDENT_SCENARIO.beats.at(-1)?.atMs;

    expect(ticks).toHaveLength(1);
    expect(ticks[0]?.atMs).toBe(lastBeatAtMs);
  });
});
