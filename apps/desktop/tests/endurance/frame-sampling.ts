// The endurance tier's frame sampler: frame durations and long tasks while the concurrent-streaming
// script delivers into the open session, and the check that the sampled window held that workload.
// Shared by the frame-time and scrolling budgets and the started-scrollbar count, so all three drive
// and read one instrument.
//
// A frame's duration is the main-thread work it costs, not the interval between frames: a sample
// runs from the start of a frame's animation-frame callback to the first task after that frame's
// rendering, a `MessageChannel` message posted from the callback. `setTimeout(0)` is not used
// because its clamped timeout would be added to every reading.
//
// Long tasks are read in both realms the window's work runs in: the window's own, and the console
// document's that opened it and renders its tree, since an entry is reported to the realm whose
// script ran it.
//
// The warm-up is a frame count, not seconds: the frozen clock only moves when this sampler moves
// it, so seconds of frames would deliver the whole script before the first sample. The advance per
// frame is derived from the script's span.

import { expect } from "vitest";

import type { AppUnderTest } from "../helpers/electron/harness.js";
import { SCENARIO_FIXTURE_GLOBAL } from "#renderer/app/fixture/global-names.js";
import {
  CONCURRENT_STREAMING_LANE_COUNT,
  CONCURRENT_STREAMING_SCENARIO,
} from "#fixtures/scenarios/concurrent-streaming.js";
import { peakConcurrentStreamingRuns } from "./streaming-lanes.js";

/**
 * How many frame durations one run samples. Three hundred puts the 95th percentile at the
 * fifteenth-slowest frame, so one hiccup moves it by a rank rather than deciding it.
 */
export const SAMPLED_FRAME_COUNT = 300;

/**
 * How many fresh launches a hardware-dependent figure is the median of.
 *
 * Each is its own launch because the frozen clock does not rewind: repeat passes in one window
 * would measure an app whose script was already delivered.
 */
export const MEASURED_RUN_COUNT = 3;

/**
 * Frames discarded before sampling starts: the first frames after a mount carry the virtualizer's
 * initial measurement pass and V8 compilation, which no frame budget bounds.
 */
const WARM_UP_FRAME_COUNT = 30;

/** What one sampled run measured. */
export interface FrameTimingRun {
  readonly frameDurationsMs: readonly number[];
  /** Every long task either realm reported inside the sampled window, in milliseconds. */
  readonly longTaskDurationsMs: readonly number[];
  readonly beatsAtWindowStart: number;
  readonly beatsAtWindowEnd: number;
}

/**
 * Samples frame durations and long tasks while the concurrent-streaming script delivers into the
 * open session. `plantedStallMilliseconds` holds each frame's callback that long, for a negative
 * control. Throws when the build exposes no scenario handle, since every frame would then describe
 * an idle window.
 */
export async function sampleFrameTimings(
  appUnderTest: AppUnderTest,
  plantedStallMilliseconds: number,
): Promise<FrameTimingRun> {
  const scriptSpanMs = CONCURRENT_STREAMING_SCENARIO.beats.at(-1)?.atMs ?? 0;
  const advanceMillisecondsPerFrame = Math.max(1, Math.ceil(scriptSpanMs / SAMPLED_FRAME_COUNT));
  const run = await appUnderTest.window.evaluate(
    async ([
      scenarioGlobalName,
      warmUpFrames,
      sampledFrames,
      advanceMilliseconds,
      stallMilliseconds,
    ]: [string, number, number, number, number]) => {
      // The scenario's handle is the console document's, which opened this window.
      const consoleRealm = (window.opener ?? globalThis) as typeof globalThis;
      const scenarioControl = (
        consoleRealm as unknown as Record<
          string,
          { advance(milliseconds: number): void; deliveredBeatCount(): number } | undefined
        >
      )[scenarioGlobalName];
      if (scenarioControl === undefined) {
        return null;
      }
      const longTaskDurationsMs: number[] = [];
      let isSampling = false;
      const realms = consoleRealm === globalThis ? [globalThis] : [globalThis, consoleRealm];
      const longTaskObservers = realms.map((realm) => {
        const observer = new realm.PerformanceObserver((list) => {
          if (isSampling) {
            for (const entry of list.getEntries()) {
              longTaskDurationsMs.push(entry.duration);
            }
          }
        });
        observer.observe({ type: "longtask" });
        return observer;
      });
      const frameDurationsMs: number[] = [];
      let beatsAtWindowStart = -1;
      await new Promise<void>((resolve) => {
        const afterFrame = new MessageChannel();
        let frameIndex = 0;
        let frameStartedAtMs = 0;
        const onFrame = (): void => {
          frameStartedAtMs = performance.now();
          if (frameIndex === warmUpFrames) {
            beatsAtWindowStart = scenarioControl.deliveredBeatCount();
            isSampling = true;
          }
          scenarioControl.advance(advanceMilliseconds);
          if (stallMilliseconds > 0) {
            const stallUntil = performance.now() + stallMilliseconds;
            while (performance.now() < stallUntil) {
              /* hold the frame, the way a renderer over its budget does */
            }
          }
          afterFrame.port2.postMessage(0);
        };
        afterFrame.port1.onmessage = (): void => {
          if (frameIndex > warmUpFrames) {
            frameDurationsMs.push(performance.now() - frameStartedAtMs);
          }
          frameIndex += 1;
          if (frameDurationsMs.length >= sampledFrames) {
            afterFrame.port1.close();
            afterFrame.port2.close();
            resolve();
            return;
          }
          requestAnimationFrame(onFrame);
        };
        requestAnimationFrame(onFrame);
      });
      for (const observer of longTaskObservers) {
        for (const entry of observer.takeRecords()) {
          longTaskDurationsMs.push(entry.duration);
        }
        observer.disconnect();
      }
      return {
        frameDurationsMs,
        longTaskDurationsMs,
        beatsAtWindowStart,
        beatsAtWindowEnd: scenarioControl.deliveredBeatCount(),
      };
    },
    [
      SCENARIO_FIXTURE_GLOBAL,
      WARM_UP_FRAME_COUNT,
      SAMPLED_FRAME_COUNT,
      advanceMillisecondsPerFrame,
      plantedStallMilliseconds,
    ] as [string, number, number, number, number],
  );
  if (run === null) {
    throw new Error(
      `${SCENARIO_FIXTURE_GLOBAL} is not exposed by this build, so no frame in it was driven by ` +
        "a scenario and every interval sampled would describe an idle window",
    );
  }
  expect(run.frameDurationsMs).toHaveLength(SAMPLED_FRAME_COUNT);
  return run;
}

/**
 * Asserts the sampled window holds the four-lane workload: the script finished inside it, was
 * still arriving during it, and four lanes streamed. The lane count comes from the scenario's
 * cast, so a stale literal cannot pass.
 */
export function expectFourLaneWorkloadInsideWindow(run: FrameTimingRun): void {
  expect(
    run.beatsAtWindowEnd,
    "the concurrent-streaming script had not finished " +
      "delivering by the end of the sampled window, so the " +
      "reading describes an app the session never fully reached",
  ).toBe(CONCURRENT_STREAMING_SCENARIO.beats.length);
  expect(
    run.beatsAtWindowEnd,
    "every beat had already been delivered before sampling started, so these frames measured a " +
      "settled app rather than one with a session arriving in it",
  ).toBeGreaterThan(run.beatsAtWindowStart);
  expect(
    peakConcurrentStreamingRuns(
      CONCURRENT_STREAMING_SCENARIO.beats,
      run.beatsAtWindowStart,
      run.beatsAtWindowEnd,
    ),
    "fewer than four agent lanes were mid-turn at any point inside the sampled window, so this " +
      "figure bounds an app that was not doing the work the budget row names",
  ).toBe(CONCURRENT_STREAMING_LANE_COUNT);
}
