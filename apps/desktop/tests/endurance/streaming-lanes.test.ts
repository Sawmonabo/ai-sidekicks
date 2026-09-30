// The lane-concurrency reader, and the claim the concurrent-streaming script makes with it.
//
// One file because it is one claim: the reader is worth something only if it says four about
// the scenario the four-lane budget row measures, and the scenario's claim is checkable only
// through the reader. The controls vary the script, not the reader, each showing a session the
// scenario could become and what the reader would then report.

import { describe, expect, it } from "vitest";
import {
  CONCURRENT_STREAMING_LANE_COUNT,
  CONCURRENT_STREAMING_SCENARIO,
} from "../../fixtures/scenarios/concurrent-streaming.js";
import { peakConcurrentStreamingRuns } from "./streaming-lanes.js";
import type { ScenarioBeat } from "../../fixtures/scenario.js";

const SESSION_ID = "019b79ee-0280-75e5-8510-ada11a5a11a5";

/**
 * The base instant the synthetic beats are spaced from, minted from its fields: `Date.parse`
 * reads a timezone-less stamp in the host's zone, so a fixture that parsed its own literal would
 * trust the one function the console bans.
 */
const streamBaseMs = Date.UTC(2026, 0, 1);

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
      occurredAt: new Date(streamBaseMs + entryIndex * 50).toISOString(),
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
    // The failure this model exists to catch: the same beats, volume and run count, and never
    // two lanes mid-turn together.
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
    // The second condition on its own: both runs are in `running` at every beat and neither
    // speaks, which the transcript draws as two idle run groups, not two streaming lanes.
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
    // A tool result landing after the run was paused belongs to no live turn; without the span
    // boundary the reader would count the lane streaming to the end of the script.
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
    // The sampled window starts part-way into the script, and a lane that began before it
    // streams through it. A reader counting only spans opened inside the range would report
    // zero for the window the budget is measured over.
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

describe("the concurrent-streaming script", () => {
  it("has one streaming lane per agent of its cast, all at once", () => {
    expect(
      peakConcurrentStreamingRuns(
        CONCURRENT_STREAMING_SCENARIO.beats,
        0,
        CONCURRENT_STREAMING_SCENARIO.beats.length,
      ),
    ).toBe(CONCURRENT_STREAMING_LANE_COUNT);
  });

  it("reaches that peak after its opening, so a sampled window contains it", () => {
    // The harness discards a warm-up before sampling, so a script whose only four-lane moment
    // sat in its first beats would be measured entirely outside it; hence the tail.
    const openingBeatCount = CONCURRENT_STREAMING_SCENARIO.beats.findIndex(
      (beat) => beat.event.kind === "assistant.thinking_update",
    );

    expect(openingBeatCount).toBeGreaterThan(0);
    expect(
      peakConcurrentStreamingRuns(
        CONCURRENT_STREAMING_SCENARIO.beats,
        openingBeatCount,
        CONCURRENT_STREAMING_SCENARIO.beats.length,
      ),
    ).toBe(CONCURRENT_STREAMING_LANE_COUNT);
  });

  it("negative control: the same script with its output removed streams nothing", () => {
    // Fails on a script with no assistant or tool rows at all. Every run transition is kept, so
    // this shows the lanes alone do not satisfy the claim.
    const withoutOutput = CONCURRENT_STREAMING_SCENARIO.beats.filter(
      (beat) => !beat.event.kind.startsWith("assistant.") && !beat.event.kind.startsWith("tool."),
    );

    expect(withoutOutput.length).toBeGreaterThan(0);
    expect(peakConcurrentStreamingRuns(withoutOutput, 0, withoutOutput.length)).toBe(0);
  });

  it("negative control: taking the lanes in sequence drops the peak to one", () => {
    // The other half: the scenario's own beats re-timed so each lane finishes before the next
    // begins, the script a reviewer would accept as "four lanes" if concurrency were not measured.
    const runIdsInOrder: string[] = [];
    for (const beat of CONCURRENT_STREAMING_SCENARIO.beats) {
      const runId = beat.event.payload?.["runId"];
      if (typeof runId === "string" && !runIdsInOrder.includes(runId)) {
        runIdsInOrder.push(runId);
      }
    }
    const sequential = runIdsInOrder.flatMap((runId) =>
      CONCURRENT_STREAMING_SCENARIO.beats.filter((beat) => beat.event.payload?.["runId"] === runId),
    );

    expect(peakConcurrentStreamingRuns(sequential, 0, sequential.length)).toBe(1);
  });
});
