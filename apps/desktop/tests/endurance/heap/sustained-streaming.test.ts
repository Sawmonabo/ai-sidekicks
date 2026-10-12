// The renderer heap over half an hour of a session streaming live: under the ceiling of
// `steady-heap-sustained-streaming` in `tests/budget/document.json`, and flat, every reading after
// the warm-up within the `steady-heap-growth` allowance of the first one. Both are compared
// through the registry's own `evaluateBudget`.
//
// The half hour is scenario time. The frozen clock is walked over the sustained-streaming script
// in stretches, each paced across a few seconds of the window's own frames, every one of which runs
// the frame work the app armed on the frozen clock after that frame's beats are in, as a reader's
// frame does, and each ending on a beat's own tick, so the wait for that beat ends the stretch
// exactly where the next one starts. After each stretch the clock is moved past the refresh
// debounce inside one more frame, so the store holds what was delivered and the reads it asked for
// have run, and the settled heap is read.
//
// The warm-up lasts until the store first lets go of events: until then it holds every event it
// was given and the heap grows with the log by design. The first reading after that is the
// baseline, and no later reading may sit above it by more than the growth allowance. A heap that
// stays under the ceiling while climbing is still a leak, which is what the second bound is for.
//
// The run must have moved for any of that to mean something: the beats delivered grow at every
// reading and reach the end of the script, the stream reaches the store through a real
// subscription, and the store keeps letting go, so the events it holds stay a stretch of the log
// whose oldest position moves on rather than the whole log. No run of the script ends, so what the
// window and the store let go are the settled rows of runs still live.

import process from "node:process";

import { describe, expect, it } from "vitest";

import { withLaunchedApp, type AppUnderTest } from "../../helpers/electron/harness.js";
import { fixtureBundleExists } from "../../helpers/fixture/bundle.js";
import { IN_WINDOW_STEP_TIMEOUT_MS } from "../../helpers/launch/body.js";
import { ENDURANCE_BODY_ALLOWANCE_MS } from "../../helpers/launch/budgets.js";
import { BudgetRegistry } from "../../helpers/budget/registry.js";
import { evaluateBudget } from "../../helpers/budget/evaluation.js";
import { SCENARIO_DRAIN_MS } from "../scenario-delivery-schedule.js";
import { readTranscriptWindow } from "../transcript/window-read.js";
import {
  SESSION_SCREEN_SELECTOR,
  advanceScenario,
  enduranceLaunchOptions,
  openRoute,
  readBoundSessionIds,
  readDeliveredBeatCount,
  readHeldTranscript,
  readPlayingScenarioId,
  startPacedDelivery,
  waitForDeliveredBeats,
} from "../workload.js";
import { expectPreciseHeapInstrument, RendererHeapProbe } from "./instrument.js";
import { SCENARIO_FIXTURE_GLOBAL } from "#renderer/app/fixture/global-names.js";
import { formatRoute } from "#renderer/routing/routes.js";
import type { HeldTranscriptReading } from "#renderer/services/session-events/diagnostics-handle.js";
import type { ScenarioBeat } from "#fixtures/scenario.js";
import { SUSTAINED_STREAMING_SCENARIO } from "#fixtures/scenarios/sustained-streaming.js";

const bundleIsBuilt = fixtureBundleExists();

const registry = BudgetRegistry.load();

/** The ceiling the heap stays under for the whole half hour; its row says why that figure. */
const streamingHeapBudget = registry.requireBudget("steady-heap-sustained-streaming");

/** How far a reading after the warm-up may sit above the first; its row says why that figure. */
const steadyHeapGrowthBudget = registry.requireBudget("steady-heap-growth");

const SESSION_ID = SUSTAINED_STREAMING_SCENARIO.sessionId;

const SESSION_ROUTE = formatRoute({ kind: "session", sessionId: SESSION_ID });

/**
 * Wall time the half hour is played across: half the body's allowance, leaving the other half for
 * the settled reading after each stretch and the steps before the first.
 */
const PLAYING_WALL_MS = ENDURANCE_BODY_ALLOWANCE_MS / 2;

/**
 * Wall time one stretch is played across: half the in-window step bound, so the wait for its last
 * beat fits that bound with room for a frame the runner delays.
 */
const STRETCH_WALL_MS = IN_WINDOW_STEP_TIMEOUT_MS / 2;

/** How many stretches the script is played in, each followed by one reading. */
const STRETCH_COUNT = Math.ceil(PLAYING_WALL_MS / STRETCH_WALL_MS);

/** What one reading after a stretch saw. */
interface StreamReading {
  /** Scenario time the clock stood at. */
  readonly scenarioMs: number;
  readonly heapBytes: number;
  readonly deliveredBeatCount: number;
  readonly heldTranscript: HeldTranscriptReading;
  /** Rows the transcript window holds and has mounted, or `null` with no viewport. */
  readonly windowRowCount: number | null;
  readonly mountedRowCount: number | null;
}

describe.skipIf(!bundleIsBuilt)("endurance — a session streaming for half an hour", () => {
  it("holds the renderer heap flat and under its ceiling", async () => {
    const beats = SUSTAINED_STREAMING_SCENARIO.beats;
    const endTicks = stretchEndTicks(beats);
    await withLaunchedApp(
      enduranceLaunchOptions(SUSTAINED_STREAMING_SCENARIO.id),
      async (appUnderTest) => {
        // A launch playing another script would measure the wrong workload and pass.
        expect(
          await readPlayingScenarioId(appUnderTest),
          `${SCENARIO_FIXTURE_GLOBAL} is not exposed by this ` +
            `build, or the launch did not select a scenario`,
        ).toBe(SUSTAINED_STREAMING_SCENARIO.id);
        await openRoute(appUnderTest, SESSION_ROUTE, SESSION_SCREEN_SELECTOR);

        const heapProbe = await RendererHeapProbe.attachTo(appUnderTest);
        const readings: StreamReading[] = [];
        try {
          // Every flatness verdict is a difference of two readings, which the default quantized
          // instrument cannot carry, so the instrument is proved first.
          await expectPreciseHeapInstrument(appUnderTest, heapProbe);
          let scenarioMs = 0;
          for (const endTick of endTicks) {
            await playStretch(appUnderTest, scenarioMs, endTick, beatsDueBy(beats, endTick));
            await advanceScenario(appUnderTest, SCENARIO_DRAIN_MS);
            scenarioMs = endTick + SCENARIO_DRAIN_MS;
            const reading = await readStream(appUnderTest, heapProbe, scenarioMs);
            readings.push(reading);
            printReading(reading, readings);
          }
        } finally {
          // Detached before the window closes: detaching from a closed application raises over
          // whatever the body was failing on.
          await heapProbe.detach();
        }

        // The workload moved at every reading and reached the end of the script.
        for (const [index, reading] of readings.slice(1).entries()) {
          expect(
            reading.deliveredBeatCount,
            `the stretch before reading ${String(index + 1)} delivered nothing`,
          ).toBeGreaterThan(readings[index]?.deliveredBeatCount ?? 0);
        }
        expect(readings.at(-1)?.deliveredBeatCount).toBe(beats.length);
        // And it reached the store through a real subscription rather than a side channel.
        expect(await readBoundSessionIds(appUnderTest)).toContain(SESSION_ID);
        expect(
          readings.at(-1)?.mountedRowCount ?? 0,
          "the transcript mounted no row, so the stream was never drawn",
        ).toBeGreaterThan(0);

        // Where the events the store holds begin; the log's first position until it lets one go.
        const firstLogPosition = beats[0]?.event.sequence ?? 0;
        const heldFrom = (reading: StreamReading): number =>
          reading.heldTranscript.firstSequence ?? firstLogPosition;
        const warmUpEnd = readings.findIndex((reading) => heldFrom(reading) > firstLogPosition);
        expect(
          warmUpEnd,
          "the store never let go of an event over the whole half hour, so it held the entire " +
            "log and nothing here says the heap stays flat while a session streams",
        ).toBeGreaterThanOrEqual(0);
        const steadyReadings = readings.slice(warmUpEnd);
        expect(
          steadyReadings.length,
          "the store first let go at the last reading, so no reading follows the warm-up",
        ).toBeGreaterThan(1);
        const baseline = steadyReadings[0];
        const finalReading = steadyReadings.at(-1);
        if (baseline === undefined || finalReading === undefined) {
          throw new Error("unreachable: the length assertion above fails first");
        }
        // The store kept letting go after the warm-up, so what it holds is a stretch that moved on.
        expect(
          heldFrom(finalReading),
          "the store let go once and then kept every later event",
        ).toBeGreaterThan(heldFrom(baseline));
        expect(finalReading.heldTranscript.eventCount).toBeLessThan(
          finalReading.deliveredBeatCount,
        );

        const peakHeapBytes = Math.max(...readings.map((reading) => reading.heapBytes));
        const ceilingVerdict = evaluateBudget(streamingHeapBudget, peakHeapBytes);
        const peakGrowthBytes = Math.max(
          ...steadyReadings.map((reading) => reading.heapBytes - baseline.heapBytes),
        );
        const flatnessVerdict = evaluateBudget(steadyHeapGrowthBudget, peakGrowthBytes);
        process.stdout.write(
          `[endurance] half hour streamed: peak heap ${kilobytes(peakHeapBytes)} ` +
            `(${(ceilingVerdict.utilizationFraction * 100).toFixed(1)} % of the ceiling), ` +
            `peak growth after warm-up ${kilobytes(peakGrowthBytes)} ` +
            `(${(flatnessVerdict.utilizationFraction * 100).toFixed(1)} % of the allowance), ` +
            `baseline at reading ${String(warmUpEnd + 1)} of ${String(readings.length)}\n`,
        );

        expect(
          ceilingVerdict.withinBudget,
          `${streamingHeapBudget.label}: ${String(peakHeapBytes)} B against ` +
            `a ${String(ceilingVerdict.limitCanonicalValue)} B ceiling`,
        ).toBe(true);
        expect(
          flatnessVerdict.withinBudget,
          `${steadyHeapGrowthBudget.label}: a reading ${String(peakGrowthBytes)} B above the ` +
            `first after the warm-up, against a ${String(flatnessVerdict.limitCanonicalValue)} B ` +
            "allowance — the heap climbed while the session streamed",
        ).toBe(true);
      },
    );
  });
});

/**
 * The tick each stretch ends on, one stretch per share of the script: the tick of the first beat
 * at or past the share's end, so the wait for that beat ends the stretch on it, and past the
 * previous end and its drain. The last ends on the script's last beat.
 */
function stretchEndTicks(beats: readonly ScenarioBeat[]): readonly number[] {
  const lastAtMs = beats.at(-1)?.atMs ?? 0;
  const endTicks: number[] = [];
  let earliestEndMs = 0;
  for (let stretch = 1; stretch <= STRETCH_COUNT; stretch += 1) {
    const shareEndMs = Math.max(earliestEndMs, Math.ceil((lastAtMs * stretch) / STRETCH_COUNT));
    const endBeat = beats.find((beat) => beat.atMs >= shareEndMs);
    if (endBeat === undefined) {
      break;
    }
    endTicks.push(endBeat.atMs);
    earliestEndMs = endBeat.atMs + SCENARIO_DRAIN_MS + 1;
  }
  if (endTicks.at(-1) !== lastAtMs) {
    throw new Error("the stretches end short of the script's last beat");
  }
  return endTicks;
}

/** How many beats fall due by `tick`. */
function beatsDueBy(beats: readonly ScenarioBeat[], tick: number): number {
  return beats.filter((beat) => beat.atMs <= tick).length;
}

/**
 * Paces the clock from `fromMs` to `toMs` across the stretch's wall time, a frame at a time, and
 * returns once the beats due by `toMs` are delivered. The pace never moves past `toMs` and the
 * last of those beats lands only on it, so the clock stands exactly there.
 */
async function playStretch(
  appUnderTest: AppUnderTest,
  fromMs: number,
  toMs: number,
  dueBeatCount: number,
): Promise<void> {
  const stopPace = await startPacedDelivery(appUnderTest, {
    leadInMs: 0,
    stretchMs: toMs - fromMs,
    durationMs: STRETCH_WALL_MS,
  });
  await waitForDeliveredBeats(appUnderTest, dueBeatCount);
  await stopPace();
}

/** The settled heap, the beats delivered, what the store holds and what the window shows. */
async function readStream(
  appUnderTest: AppUnderTest,
  heapProbe: RendererHeapProbe,
  scenarioMs: number,
): Promise<StreamReading> {
  const heapBytes = await heapProbe.readSettledBytes();
  const deliveredBeatCount = await readDeliveredBeatCount(appUnderTest);
  const heldTranscript = await readHeldTranscript(appUnderTest, SESSION_ID);
  if (heldTranscript === null) {
    throw new Error(`no store is open for ${SESSION_ID}, or this build exposes no diagnostics`);
  }
  const transcriptWindow = await readTranscriptWindow(appUnderTest, SESSION_ID);
  return {
    scenarioMs,
    heapBytes,
    deliveredBeatCount,
    heldTranscript,
    windowRowCount: transcriptWindow?.totalRowCount ?? null,
    mountedRowCount: transcriptWindow?.mountedRowCount ?? null,
  };
}

/** One line per reading, printed as it is taken, so a run failing part-way shows its trend. */
function printReading(reading: StreamReading, readings: readonly StreamReading[]): void {
  const firstReading = readings[0];
  const sinceFirst = firstReading === undefined ? 0 : reading.heapBytes - firstReading.heapBytes;
  process.stdout.write(
    `[endurance] ${minutesAndSeconds(reading.scenarioMs)} streamed: heap ` +
      `${kilobytes(reading.heapBytes)} (${sinceFirst >= 0 ? "+" : ""}${kilobytes(sinceFirst)} ` +
      `since the first reading), ${String(reading.deliveredBeatCount)} beats delivered, store ` +
      `holds ${String(reading.heldTranscript.eventCount)} events from position ` +
      `${String(reading.heldTranscript.firstSequence)}, window holds ` +
      `${String(reading.windowRowCount)} rows with ${String(reading.mountedRowCount)} mounted\n`,
  );
}

function kilobytes(bytes: number): string {
  return `${String(Math.round(bytes / 1024))} kB`;
}

function minutesAndSeconds(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${String(Math.floor(totalSeconds / 60))}:${seconds}`;
}
