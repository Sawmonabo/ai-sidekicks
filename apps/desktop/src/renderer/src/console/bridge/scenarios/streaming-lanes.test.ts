// The lane-concurrency reader, and the claim the flagship script makes with it.
//
// Two subjects in one file because they are one claim: the reader is only worth
// anything if it says four about the scenario the four-lane budget row measures, and
// the scenario's claim is only checkable through the reader. The controls below vary
// the SCRIPT rather than the reader, so each one shows a session the flagship could
// become and the number the reader would then report.

import { describe, expect, it } from "vitest";

import { FLAGSHIP_LANE_COUNT, FLAGSHIP_SCENARIO } from "./flagship.js";
import { peakConcurrentStreamingRuns } from "./streaming-lanes.js";
import type { ScenarioBeat } from "../scenario.js";

const SESSION_ID = "019b79ee-0280-75e5-8510-ada11a5a11a5";

/** Beats for a script written as `[kind, payload]` pairs, positioned and stamped. */
function beatsFor(
  entries: readonly (readonly [string, Record<string, unknown>])[],
): ScenarioBeat[] {
  return entries.map(([kind, payload], entryIndex) => ({
    atMs: entryIndex * 50,
    event: {
      id: `019b79ee-0280-7ea1-8110-e5e0d115${String(entryIndex + 1).padStart(4, "0")}`,
      sessionId: SESSION_ID,
      sequence: entryIndex + 1,
      kind,
      occurredAt: new Date(Date.parse("2026-01-01T00:00:00.000Z") + entryIndex * 50).toISOString(),
      payload,
    },
  }));
}

/** One run's whole turn: it starts running, says two things, and stops. */
function laneEntries(runId: string): readonly (readonly [string, Record<string, unknown>])[] {
  return [
    ["run.running", { sessionId: SESSION_ID, runId, runVersion: 1, newState: "running" }],
    ["assistant.thinking_update", { sessionId: SESSION_ID, runId, contentLength: 10 }],
    ["assistant.message", { sessionId: SESSION_ID, runId, contentLength: 20 }],
    ["run.completed", { sessionId: SESSION_ID, runId, runVersion: 2, newState: "completed" }],
  ];
}

describe("peakConcurrentStreamingRuns", () => {
  it("counts one lane at a time when the runs are taken in sequence", () => {
    // The failure this whole model exists to catch. The same beats, the same
    // volume of output, the same run count — and not one moment where two lanes
    // are mid-turn together.
    const beats = beatsFor([...laneEntries("run-a"), ...laneEntries("run-b")]);

    expect(peakConcurrentStreamingRuns(beats, 0, beats.length)).toBe(1);
  });

  it("counts both lanes when their turns overlap", () => {
    const beats = beatsFor([
      [
        "run.running",
        { sessionId: SESSION_ID, runId: "run-a", runVersion: 1, newState: "running" },
      ],
      [
        "run.running",
        { sessionId: SESSION_ID, runId: "run-b", runVersion: 1, newState: "running" },
      ],
      ["assistant.message", { sessionId: SESSION_ID, runId: "run-a", contentLength: 10 }],
      ["assistant.message", { sessionId: SESSION_ID, runId: "run-b", contentLength: 10 }],
      ["assistant.message", { sessionId: SESSION_ID, runId: "run-a", contentLength: 10 }],
      ["assistant.message", { sessionId: SESSION_ID, runId: "run-b", contentLength: 10 }],
    ]);

    expect(peakConcurrentStreamingRuns(beats, 0, beats.length)).toBe(2);
  });

  it("does not count a run that is running with nothing left to say", () => {
    // The second conjunct, on its own. Both runs are in `running` at every beat
    // and neither ever speaks, which is a session the ledger draws two idle
    // chapters for — and is not two streaming lanes.
    const beats = beatsFor([
      [
        "run.running",
        { sessionId: SESSION_ID, runId: "run-a", runVersion: 1, newState: "running" },
      ],
      [
        "run.running",
        { sessionId: SESSION_ID, runId: "run-b", runVersion: 1, newState: "running" },
      ],
    ]);

    expect(peakConcurrentStreamingRuns(beats, 0, beats.length)).toBe(0);
  });

  it("stops counting a lane once it leaves `running`, even with output after it", () => {
    // A tool result that lands after the run was paused belongs to no live turn.
    // Without the span boundary the reader would count the pause away and keep
    // the lane streaming to the end of the script.
    const beats = beatsFor([
      [
        "run.running",
        { sessionId: SESSION_ID, runId: "run-a", runVersion: 1, newState: "running" },
      ],
      ["run.paused", { sessionId: SESSION_ID, runId: "run-a", runVersion: 2, newState: "paused" }],
      ["assistant.message", { sessionId: SESSION_ID, runId: "run-a", contentLength: 10 }],
    ]);

    expect(peakConcurrentStreamingRuns(beats, 0, beats.length)).toBe(0);
  });

  it("counts a lane that opened before the window and is still mid-turn inside it", () => {
    // What the endurance harness needs: its sampled window starts part-way into
    // the script, and a lane that began streaming before it is streaming through
    // it. A reader that only counted spans opening inside the range would report
    // zero for exactly the window the budget is measured over.
    const beats = beatsFor([
      [
        "run.running",
        { sessionId: SESSION_ID, runId: "run-a", runVersion: 1, newState: "running" },
      ],
      ["assistant.thinking_update", { sessionId: SESSION_ID, runId: "run-a", contentLength: 10 }],
      ["assistant.message", { sessionId: SESSION_ID, runId: "run-a", contentLength: 10 }],
    ]);

    expect(peakConcurrentStreamingRuns(beats, 1, beats.length)).toBe(1);
  });

  it("reports nothing for an empty range", () => {
    const beats = beatsFor(laneEntries("run-a"));

    expect(peakConcurrentStreamingRuns(beats, 2, 2)).toBe(0);
  });
});

describe("the flagship script", () => {
  it("has one streaming lane per attached agent, all at once", () => {
    expect(
      peakConcurrentStreamingRuns(FLAGSHIP_SCENARIO.beats, 0, FLAGSHIP_SCENARIO.beats.length),
    ).toBe(FLAGSHIP_LANE_COUNT);
  });

  it("reaches that peak after its opening, so a sampled window contains it", () => {
    // The endurance harness discards a warm-up before it starts sampling, so a
    // script whose only four-lane moment sat in the first few beats would be
    // measured entirely outside it. The peak is asserted over the tail rather
    // than over the whole script for that reason.
    const openingBeatCount = FLAGSHIP_SCENARIO.beats.findIndex(
      (beat) => beat.event.kind === "assistant.thinking_update",
    );

    expect(openingBeatCount).toBeGreaterThan(0);
    expect(
      peakConcurrentStreamingRuns(
        FLAGSHIP_SCENARIO.beats,
        openingBeatCount,
        FLAGSHIP_SCENARIO.beats.length,
      ),
    ).toBe(FLAGSHIP_LANE_COUNT);
  });

  it("negative control: the same script with its output removed streams nothing", () => {
    // The control that fails on the revision this file was written against, whose
    // flagship script carried eight beats and no assistant or tool row at all. Every
    // run transition is kept, so what is shown is that the lanes alone do not
    // satisfy the claim.
    const withoutOutput = FLAGSHIP_SCENARIO.beats.filter(
      (beat) => !beat.event.kind.startsWith("assistant.") && !beat.event.kind.startsWith("tool."),
    );

    expect(withoutOutput.length).toBeGreaterThan(0);
    expect(peakConcurrentStreamingRuns(withoutOutput, 0, withoutOutput.length)).toBe(0);
  });

  it("negative control: taking the lanes in sequence drops the peak to one", () => {
    // The other half. The beats are the flagship's own, re-timed so each lane
    // finishes before the next begins — which is the script a reviewer would
    // accept as "four lanes" if concurrency were not measured.
    const runIdsInOrder: string[] = [];
    for (const beat of FLAGSHIP_SCENARIO.beats) {
      const runId = beat.event.payload?.["runId"];
      if (typeof runId === "string" && !runIdsInOrder.includes(runId)) {
        runIdsInOrder.push(runId);
      }
    }
    const sequential = runIdsInOrder.flatMap((runId) =>
      FLAGSHIP_SCENARIO.beats.filter((beat) => beat.event.payload?.["runId"] === runId),
    );

    expect(peakConcurrentStreamingRuns(sequential, 0, sequential.length)).toBe(1);
  });
});
