// The transcript under a log as long as it claims to survive. This file measures the
// transcript's own fold, `deriveTranscriptWindow` (a session's event log into rows, run groups,
// seams and a superseded index), over a generated session of ten thousand rows, without launching
// Electron.
//
// It cannot launch one: the endurance log is not a scenario in `fixtures/index.ts`, so no
// launched app can be asked to play it. The generator is called directly with the row count.
//
// A Node heap reading is honest here though not in `heap/at-rest.test.ts`. That file's subject
// is the renderer heap, which a Node process cannot reach. This file's subject is the fold's own
// retained structures, which live in whatever process runs the fold. It states no renderer
// ceiling.
//
// Three claims:
//   - It folds the whole log. This is the control for the other two: a fold that dropped nine
//     thousand rows would be fast, retain nothing, and pass everything else.
//   - Its cost is about linear in the log. A quadratic fold is invisible at the two hundred rows
//     other tiers use and fatal at ten thousand. Measured as a ratio between two sizes rather
//     than a wall-clock ceiling, so a slower machine does not break it.
//   - Repeating it retains nothing. A fold that held its own output (a cache keyed by a value
//     never equal twice, a listener, a closure over the previous window) grows without bound in
//     an app left open for a day.
//
// The same log measures the session store's repair of a window missing a fifty-row hole, the most
// one stream frame carries. Two claims:
//   - A repair sends again only what follows the last row the window holds whole. A hole mid-window
//     and one near its newest end each take the frames of the rows after them; the replay from the
//     window's head, the widest, takes the window's.
//   - It holds no row twice, and its fold costs at most twice the window's live delivery. Every row
//     the window held is kept as the same object, so the replay is fed fresh objects and only the
//     hole's rows may come out new; the cost is a ratio against the live delivery, as above.
//
// The collection is forced through `heap/sampling.ts`, the tier's one sampler. A runtime that
// gives no collector fails the case instead of falling back to a softer reading: a heap claim
// without a collection is about what V8 had not got round to yet.

import process from "node:process";

import type { EventCursor } from "@ai-sidekicks/contracts/session/id";
import { STREAM_FRAME_MAX_CHANGES } from "@ai-sidekicks/contracts/jsonrpc/streaming";
import { describe, expect, it } from "vitest";

import { EntityProjectorRegistry } from "#renderer/registries/entity-projectors/registry.js";
import {
  APPROVAL_FLOW_PROJECTOR_OWNER,
  APPROVAL_FLOW_PROJECTORS,
} from "#renderer/store/session/events/approval-flow-projection.js";
import {
  RUN_LIFECYCLE_PROJECTOR_OWNER,
  RUN_LIFECYCLE_PROJECTORS,
} from "#renderer/store/session/events/run/lifecycle-projector.js";
import type {
  EntityProjectorTable,
  ProjectedSessionEvent,
} from "#renderer/store/session/entities/vocabulary.js";
import type { SessionBaseState } from "#renderer/store/session/state.js";
import { SessionStore } from "#renderer/store/session/store.js";
import { HeapSampler, retainedGrowthBytes } from "../heap/sampling.js";
import { createTranscriptEnduranceFixture } from "./long-log.test-support.js";
import { deriveTranscriptWindow } from "#renderer/features/transcript/window/transcript-window.js";
import { BudgetRegistry } from "../../helpers/budget/registry.js";
import { evaluateBudget } from "../../helpers/budget/evaluation.js";

/**
 * The length of log this tier measures the transcript at.
 *
 * Passed to the generator explicitly on every call, since a default deciding it would report one
 * number while measuring whatever the fixture held.
 */
const ENDURANCE_ROW_COUNT = 10_000;

/** A quarter of it, so the cost ratio below is read across a 4× step. */
const LINEARITY_PROBE_ROW_COUNT = 2_500;

const registry = BudgetRegistry.load();

/** How much costlier the long fold may be than the short one; its row says why that figure. */
const foldCostRatioBudget = registry.requireBudget("transcript-fold-cost-ratio");

/** How many times the fold is repeated when looking for what it keeps. */
const REPEATED_FOLD_COUNT = 20;

/** What the repeated folds may add to the heap and still pass; its row says why that figure. */
const foldRetentionBudget = registry.requireBudget("transcript-fold-retention");

/** Timing passes per measurement. The fastest is taken; more only sharpens it. */
const MEASUREMENT_SAMPLE_COUNT = 5;

/** The rows a repaired hole spans: one stream frame's worth, the most a frame carries. */
const REPAIR_HOLE_WIDTH = STREAM_FRAME_MAX_CHANGES;

/** Where the measured holes open: mid-window, and near its newest end. */
const REPAIR_HOLE_POSITIONS = [5_000, 9_900] as const;

/** How much costlier the repair may fold than the live delivery; its row says why that figure. */
const repairCostRatioBudget = registry.requireBudget("transcript-repair-fold-cost-ratio");

/** Where a repair's stream reopens: after the last row before the hole, or at the window's head. */
type RepairOpening = "after-last-whole-row" | "head";

/** What one repair cost, the fastest pass of each fold, and the rows it holds as new objects. */
interface RepairReading {
  readonly frames: number;
  readonly repairFoldMilliseconds: number;
  readonly liveFoldMilliseconds: number;
  readonly newRowObjects: number;
}

/** One generated session's log, as the events a store would have admitted. */
function enduranceTranscript(rowCount: number): readonly ProjectedSessionEvent[] {
  return createTranscriptEnduranceFixture({ rowCount });
}

/**
 * How long the transcript's fold takes over one log, best of several passes.
 *
 * The best rather than the mean, because the distribution is one-sided: a collection or the
 * scheduler can slow a sample and nothing can make one faster than the work takes. The result is
 * read so the compiler cannot eliminate the fold as dead code.
 */
function fastestFoldMilliseconds(transcript: readonly ProjectedSessionEvent[]): number {
  let fastestPass = Number.POSITIVE_INFINITY;
  for (let sampleIndex = 0; sampleIndex < MEASUREMENT_SAMPLE_COUNT; sampleIndex += 1) {
    const startedAt = performance.now();
    const transcriptWindow = deriveTranscriptWindow(transcript);
    const elapsedMilliseconds = performance.now() - startedAt;
    if (transcriptWindow.rows.length === 0) {
      throw new Error("the fold produced no rows, so its timing describes nothing");
    }
    fastestPass = Math.min(fastestPass, elapsedMilliseconds);
  }
  return fastestPass;
}

/** The projectors the app opens every session store with, composed the way it composes them. */
function appProjectors(): EntityProjectorTable {
  const projectorRegistry = new EntityProjectorRegistry();
  projectorRegistry.registerAll(RUN_LIFECYCLE_PROJECTORS, RUN_LIFECYCLE_PROJECTOR_OWNER);
  projectorRegistry.registerAll(APPROVAL_FLOW_PROJECTORS, APPROVAL_FLOW_PROJECTOR_OWNER);
  return projectorRegistry.snapshot();
}

/** A log cut into stream frames of the most changes one carries. */
function framesOf(rows: readonly ProjectedSessionEvent[]): readonly ProjectedSessionEvent[][] {
  const frames: ProjectedSessionEvent[][] = [];
  for (let start = 0; start < rows.length; start += STREAM_FRAME_MAX_CHANGES) {
    frames.push(rows.slice(start, start + STREAM_FRAME_MAX_CHANGES));
  }
  return frames;
}

/**
 * Delivers the long window live with a hole at `holeAt`, then repairs it from `opening`: the read
 * lands, and the stream sends the log again from there as fresh objects, frame by frame, until the
 * window is whole. Each fold is the fastest of several passes.
 */
function measureRepair(holeAt: number, opening: RepairOpening): RepairReading {
  const projectors = appProjectors();
  let liveFoldMilliseconds = Number.POSITIVE_INFINITY;
  let repairFoldMilliseconds = Number.POSITIVE_INFINITY;
  let frames = 0;
  let newRowObjects = 0;
  for (let sampleIndex = 0; sampleIndex < MEASUREMENT_SAMPLE_COUNT; sampleIndex += 1) {
    const log = enduranceTranscript(ENDURANCE_ROW_COUNT);
    const sentAgain = enduranceTranscript(ENDURANCE_ROW_COUNT);
    const lastWholeRow = log.find((event) => event.sequence === holeAt - 1);
    if (lastWholeRow === undefined) {
      throw new Error(`the log holds no row before ${String(holeAt)}, so no hole opens there`);
    }
    const store = new SessionStore({ sessionId: lastWholeRow.sessionId, projectors });
    store.initialize({ entities: [] });
    const liveStartedAt = performance.now();
    for (const frame of framesOf(
      log.filter(
        (event) => event.sequence < holeAt || event.sequence >= holeAt + REPAIR_HOLE_WIDTH,
      ),
    )) {
      store.applyBatch(frame);
    }
    liveFoldMilliseconds = Math.min(liveFoldMilliseconds, performance.now() - liveStartedAt);
    const held = store.snapshot();
    if (held.degradedCause !== "sequence-gap") {
      throw new Error("the live delivery opened no hole, so no repair is measured");
    }

    const base: SessionBaseState =
      opening === "head"
        ? { entities: [] }
        : { entities: [], streamAfterCursor: lastWholeRow.cursor as EventCursor };
    const resent =
      opening === "head"
        ? sentAgain
        : sentAgain.filter((event) => event.sequence > lastWholeRow.sequence);
    const repairStartedAt = performance.now();
    store.initialize(base);
    frames = 0;
    for (const frame of framesOf(resent)) {
      store.applyBatch(frame);
      frames += 1;
      if (!store.snapshot().isReplaying) {
        break;
      }
    }
    repairFoldMilliseconds = Math.min(repairFoldMilliseconds, performance.now() - repairStartedAt);
    const whole = store.snapshot();
    if (
      whole.isReplaying ||
      whole.degradedCause !== undefined ||
      whole.transcript.length !== ENDURANCE_ROW_COUNT
    ) {
      throw new Error("the repair never made the window whole, so its timing describes nothing");
    }
    const heldRows = new Set(held.transcript);
    newRowObjects = whole.transcript.filter((row) => !heldRows.has(row)).length;
  }
  return { frames, repairFoldMilliseconds, liveFoldMilliseconds, newRowObjects };
}

describe("endurance — the transcript's fold over a long session", () => {
  it("folds every row of a ten-thousand-row session into one complete window", () => {
    // The control for everything else here: a fold that silently dropped most of the log would
    // be fast, retain almost nothing, and satisfy both claims below.
    const transcript = enduranceTranscript(ENDURANCE_ROW_COUNT);
    expect(transcript).toHaveLength(ENDURANCE_ROW_COUNT);

    const transcriptWindow = deriveTranscriptWindow(transcript);

    // Every event the generator scripts is a registered kind the projection places, so every one
    // becomes a row; a window that dropped an event category would otherwise still read complete.
    expect(transcriptWindow.rows).toHaveLength(ENDURANCE_ROW_COUNT);
    // The virtualizer's identity list and the body lookup are two views of one set: a viewport
    // row with no body renders the not-loaded absence, and a body with no viewport row is never
    // drawn.
    expect(transcriptWindow.viewportRows).toHaveLength(transcriptWindow.rows.length);
    expect(transcriptWindow.rowsByKey.size).toBe(transcriptWindow.rows.length);
    // Every generated run group closes, so the window holds no live turn and every row hanging
    // from a run group is collapsed under the terminal run group fold. The rows not collapsed
    // are exactly those belonging to no run group: the session's opening beats. Stated that way
    // rather than as a count, so it does not encode how many beats the generator spends opening
    // a session, and it still fails the day the run group index stops recognizing a run's
    // terminal at scale.
    expect(transcriptWindow.hasActiveTurn).toBe(false);
    const uncollapsedRowKinds = new Set(
      transcriptWindow.rows
        .filter((row) => !transcriptWindow.collapsedRowIds.has(row.id))
        .map((row) => row.kind),
    );
    expect([...uncollapsedRowKinds]).toStrictEqual(["general"]);
    expect(transcriptWindow.collapsedRowIds.size).toBeGreaterThan(0);
  });

  it("does not fold superlinearly as the log grows", () => {
    const shortFoldMilliseconds = fastestFoldMilliseconds(
      enduranceTranscript(LINEARITY_PROBE_ROW_COUNT),
    );
    const longFoldMilliseconds = fastestFoldMilliseconds(enduranceTranscript(ENDURANCE_ROW_COUNT));
    const costRatio = longFoldMilliseconds / shortFoldMilliseconds;

    // Reported before the assertion so a shrinking margin is visible.
    process.stdout.write(
      `[endurance] transcript fold ${shortFoldMilliseconds.toFixed(2)} ms at ` +
        `${String(LINEARITY_PROBE_ROW_COUNT)} rows, ${longFoldMilliseconds.toFixed(2)} ms at ` +
        `${String(ENDURANCE_ROW_COUNT)} rows — ${costRatio.toFixed(2)}× over a 4× log ` +
        `(ceiling ${String(foldCostRatioBudget.limit.canonicalValue)}×)\n`,
    );

    expect(
      evaluateBudget(foldCostRatioBudget, costRatio).withinBudget,
      `${foldCostRatioBudget.label}: ${costRatio.toFixed(2)}× against a ` +
        `${String(foldCostRatioBudget.limit.canonicalValue)}× ceiling`,
    ).toBe(true);
  });

  it("retains nothing of the folds it has already produced", async () => {
    const heapSampler = new HeapSampler();
    if (!heapSampler.isCollectorAvailable) {
      throw new Error(
        "this runtime gives no collector, so no heap figure " +
          "here would describe what the transcript retains",
      );
    }
    // One fold before the baseline, dropped, so the first fold's one-time costs (the
    // projection's module state, V8's compiled code) are not reported as retention.
    const transcript = enduranceTranscript(ENDURANCE_ROW_COUNT);
    dropFoldOf(transcript);
    const baseline = await heapSampler.sample();

    for (let foldIndex = 0; foldIndex < REPEATED_FOLD_COUNT; foldIndex += 1) {
      dropFoldOf(transcript);
    }
    const retainedBytes = retainedGrowthBytes(baseline, await heapSampler.sample());

    process.stdout.write(
      `[endurance] transcript fold retention ${String(Math.round(retainedBytes / 1024))} kB ` +
        `over ${String(REPEATED_FOLD_COUNT)} folds of ${String(ENDURANCE_ROW_COUNT)} rows ` +
        `(ceiling ${String(Math.round(foldRetentionBudget.limit.canonicalValue / 1024))} kB)\n`,
    );

    expect(
      evaluateBudget(foldRetentionBudget, retainedBytes).withinBudget,
      `${foldRetentionBudget.label}: ${String(retainedBytes)} B against a ` +
        `${String(foldRetentionBudget.limit.canonicalValue)} B ceiling`,
    ).toBe(true);
  });
});

describe("endurance — the session store repairs a long window", () => {
  it.each(REPAIR_HOLE_POSITIONS)(
    "repairs a hole at %i from the row before it, sending again only what follows",
    (holeAt) => {
      const reading = measureRepair(holeAt, "after-last-whole-row");

      process.stdout.write(
        `[endurance] repair of a ${String(REPAIR_HOLE_WIDTH)}-row hole at ${String(holeAt)} of ` +
          `${String(ENDURANCE_ROW_COUNT)} rows: ${String(reading.frames)} frames, fold ` +
          `${reading.repairFoldMilliseconds.toFixed(2)} ms (live delivery ` +
          `${reading.liveFoldMilliseconds.toFixed(2)} ms)\n`,
      );

      // The stream reopens after the row before the hole and sends every row from the hole on once.
      expect(reading.frames).toBe(
        Math.ceil((ENDURANCE_ROW_COUNT - holeAt) / STREAM_FRAME_MAX_CHANGES),
      );
      expect(reading.newRowObjects).toBe(REPAIR_HOLE_WIDTH);
    },
  );

  it("replays from the window's head in at most twice the window's live delivery", () => {
    const reading = measureRepair(REPAIR_HOLE_POSITIONS[0], "head");
    const costRatio = reading.repairFoldMilliseconds / reading.liveFoldMilliseconds;

    process.stdout.write(
      `[endurance] repair from the head of ${String(ENDURANCE_ROW_COUNT)} rows: ` +
        `${String(reading.frames)} frames, fold ${reading.repairFoldMilliseconds.toFixed(2)} ms ` +
        `against ${reading.liveFoldMilliseconds.toFixed(2)} ms live — ${costRatio.toFixed(2)}× ` +
        `(ceiling ${String(repairCostRatioBudget.limit.canonicalValue)}×)\n`,
    );

    expect(reading.frames).toBe(Math.ceil(ENDURANCE_ROW_COUNT / STREAM_FRAME_MAX_CHANGES));
    expect(reading.newRowObjects).toBe(REPAIR_HOLE_WIDTH);
    expect(
      evaluateBudget(repairCostRatioBudget, costRatio).withinBudget,
      `${repairCostRatioBudget.label}: ${costRatio.toFixed(2)}× against a ` +
        `${String(repairCostRatioBudget.limit.canonicalValue)}× ceiling`,
    ).toBe(true);
  });
});

/**
 * Folds once and keeps nothing.
 *
 * A named function because no binding may outlive the call: a loop assigning each window to an
 * outer variable would hold the last one alive and measure the test, not the transcript. The
 * length is read so the fold cannot be eliminated as dead.
 */
function dropFoldOf(transcript: readonly ProjectedSessionEvent[]): void {
  const rowCount = deriveTranscriptWindow(transcript).rows.length;
  if (rowCount === 0) {
    throw new Error("the fold produced no rows, so nothing was measured");
  }
}
