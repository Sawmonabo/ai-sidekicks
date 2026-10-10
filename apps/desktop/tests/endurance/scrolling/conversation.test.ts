// The conversation's scrolling budgets: a series of quick flings at 8,000 px/s up through a long
// conversation, idle and with four lanes streaming, read from the window's own frame and input
// records in a DevTools trace (`../trace/scroll.ts`); the other scrollers' budgets are
// `scrollers.test.ts`'s.
//
// Each fling is wheel input the DevTools protocol synthesizes at that speed over two screen
// heights, and the flings are spaced further apart than the pause that ends one of the
// transcript's gestures. The transcript admits one stretch of three screen heights past an edge
// the reader nears, once per gesture, so a fling shorter than a stretch never meets the window's
// edge: the series reads the conversation as a person flinging back through it does.
//
// Four readings per launch. The gaps between the frames presented while each fling moved the
// content, in milliseconds, whose 95th percentile may pass one refresh by 1 ms. The share of the
// frames that moved the content that Chromium judged janky. The frames drawn with content not yet
// rastered. And how soon each fling first moved the content, against a plain page flung the same
// way afterwards in the same window: the conversation's markup and the app's sheets replaced by
// static paragraphs, with nothing streaming. The window's own listeners stay, so the difference
// is what the conversation costs.
//
// All four depend on how fast the machine draws, rasters and delivers input, so they gate on the
// pinned runner class (`../pinned-runner-class.ts`) and are printed everywhere else, as the other
// scrollers' timings are; none is a fact of how the window is painted alone, as where a scroll is
// hit-tested is. What makes a run a measurement holds on every machine: each fling is its own
// gesture, each one moved the content, and the streaming runs had four lanes mid-turn from the
// first fling to the last. So do the controls: blurring layers over the conversation must fail the
// frame gap and the jank share, and a wheel handler that holds each turn must fail the first moved
// frame. No control plants unrastered content, since nothing a page plants reliably outruns raster.
//
// Every run is a fresh launch, because the scenario's frozen clock does not rewind. Idle, the clock
// stops at the end of the history; streaming, it moves through the four lanes' stretch at a steady
// pace across the series (`startPacedDelivery`). Each load launches once cold, printed on its own
// as the first-launch figure, and gates on the median over the warm launches after it
// (`../frame-sampling.ts` says why).

import process from "node:process";

import type { CDPSession } from "playwright";
import { describe, expect, it } from "vitest";

import { withLaunchedApp, type AppUnderTest } from "../../helpers/electron/harness.js";
import { fixtureBundleExists } from "../../helpers/fixture/bundle.js";
import { IN_WINDOW_STEP_TIMEOUT_MS } from "../../helpers/launch/body.js";
import { medianOf, percentileByNearestRank } from "../../helpers/sample-statistics.js";
import { measureLaunches } from "../frame-sampling.js";
import { RUNNER_CLASS_DESCRIPTION, isPinnedRunnerClass } from "../pinned-runner-class.js";
import { findStreamingStretch } from "../streaming-lanes.js";
import { endTraceRecording, startTraceRecording } from "../trace/recording.js";
import {
  SCROLL_TRACE_CATEGORIES,
  readScrollTrace,
  requirePresentedFrameGaps,
  type ScrollReading,
} from "../trace/scroll.js";
import { TRANSCRIPT_ROW_BOX_SELECTOR } from "../transcript/window-read.js";
import {
  CONVERSATION_SCROLLER_SELECTOR,
  SESSION_SCREEN_SELECTOR,
  advanceScenario,
  enduranceLaunchOptions,
  openRoute,
  readDeliveredBeatCount,
  startPacedDelivery,
  waitForIdleWindow,
  type PacedDeliveryReading,
} from "../workload.js";
import { BLURRING_LAYER_COUNT, plant, type Plant } from "./planted-regressions.js";
import {
  TRANSCRIPT_GESTURE_GAP_MS,
  TRANSCRIPT_STRETCH_SCREEN_HEIGHTS,
} from "#renderer/features/transcript/viewport/caps.js";
import { formatRoute } from "#renderer/routing/routes.js";
import { CONCURRENT_STREAMING_LANE_COUNT } from "#fixtures/scenarios/concurrent-streaming.js";
import {
  LONG_CONVERSATION_HISTORY_END_MS,
  LONG_CONVERSATION_SCENARIO,
} from "#fixtures/scenarios/long-conversation.js";
import { BudgetRegistry } from "../../helpers/budget/registry.js";
import { evaluateBudget, type BudgetVerdict } from "../../helpers/budget/evaluation.js";

const bundleIsBuilt = fixtureBundleExists();

const budgetRegistry = BudgetRegistry.load();
const frameGapBudget = budgetRegistry.requireBudget("scrolling-conversation-frame-gap");
const jankyFramesBudget = budgetRegistry.requireBudget("scrolling-conversation-janky-frames");
const unrasteredFramesBudget = budgetRegistry.requireBudget(
  "scrolling-conversation-unrastered-frames",
);
const firstMovedFrameBudget = budgetRegistry.requireBudget(
  "scrolling-conversation-first-moved-frame",
);

/** The two loads the row names. */
const CONVERSATION_LOADS = ["idle", "four lanes streaming"] as const;

type ConversationLoad = (typeof CONVERSATION_LOADS)[number];

/** What one launch measured: the conversation's series, then the plain page's. */
interface ConversationRun {
  readonly conversation: ScrollReading;
  readonly plainPage: ScrollReading;
}

/** What one launch does: the load, how many flings, and what a negative control plants. */
interface RunOptions {
  readonly load: ConversationLoad;
  readonly flingCount: number;
  readonly planted: Plant | undefined;
}

/** The fling's speed, in pixels a second. */
const FLING_SPEED_PX_PER_SECOND = 8_000;

/**
 * Flings in one measured series: over a thousand frames that move the content on a 120 Hz display,
 * so one janky frame is under a tenth of a percent of a run, and a median of first moved frames.
 */
const FLING_COUNT = 60;

/** Flings in a negative control's series: enough frames for its reading to cross the ceiling. */
const CONTROL_FLING_COUNT = 10;

/** One fling's travel, in screen heights: one short of a stretch, so it never meets an edge. */
const FLING_SCREEN_HEIGHTS = TRANSCRIPT_STRETCH_SCREEN_HEIGHTS - 1;

/** The pause between two flings: twice what ends a gesture, so each fling is one of its own. */
const PAUSE_BETWEEN_FLINGS_MS = 2 * TRANSCRIPT_GESTURE_GAP_MS;

/**
 * One refresh of the slowest display a reading here is taken on, in milliseconds: the pinned
 * runner's Xvfb display refreshes at 60 Hz.
 */
const SLOWEST_DISPLAY_REFRESH_MS = 1000 / 60;

/**
 * How long the planted wheel handler holds each turn: three refreshes of the slowest display, far
 * past the one millisecond the first moved frame may trail the plain page's by, on any display.
 */
const WHEEL_HOLD_MS = Math.ceil(3 * SLOWEST_DISPLAY_REFRESH_MS);

/** The plain page's paragraph, and how often a code block stands in for one. */
const PLAIN_PARAGRAPH =
  "The quick brown fox jumps over the lazy dog while the build runs and the reviewer reads " +
  "every line of the change, twice, before approving it with a note about the tests.";
const PLAIN_CODE_EVERY = 5;

/** How many paragraphs the plain page adds between two reads of its height. */
const PLAIN_PARAGRAPH_BATCH = 200;

const CONVERSATION_ROUTE = formatRoute({
  kind: "session",
  sessionId: LONG_CONVERSATION_SCENARIO.sessionId,
});

/** The beats of the history, all delivered once the clock reaches its end, and no lane's. */
const HISTORY_BEAT_COUNT = LONG_CONVERSATION_SCENARIO.beats.filter(
  (beat) => beat.atMs <= LONG_CONVERSATION_HISTORY_END_MS,
).length;

/** The four lanes' stretch, in delivered-beat counts: four mid-turn at every point inside it. */
const FOUR_LANE_STRETCH = findStreamingStretch(
  LONG_CONVERSATION_SCENARIO.beats,
  CONCURRENT_STREAMING_LANE_COUNT,
);

describe.skipIf(!bundleIsBuilt)("endurance — scrolling the conversation", () => {
  for (const load of CONVERSATION_LOADS) {
    it(`${load}: a frame each refresh through the flings, no janky or unrastered frame, each fling moving as soon as on a plain page`, async () => {
      // Every launch runs inside the test: the harness binds each app's lifetime to the running
      // test, which a hook is not.
      const { firstLaunch, warmLaunches: runs } = await measureLaunches(
        async () =>
          await scrollConversationOnce({ load, flingCount: FLING_COUNT, planted: undefined }),
      );
      reportFirstLaunch(load, firstLaunch);

      const frameGapExcessesMs = runs.map(({ conversation }) => frameGapExcessMs(conversation));
      const frameGapMs = medianOf(frameGapExcessesMs);
      const frameGapVerdict = evaluateBudget(frameGapBudget, frameGapMs);
      report(
        load,
        `presented-frame gap p95 ${frameGapMs.toFixed(2)} ms past one refresh (median of warm ` +
          `launches ${describeFigures(frameGapExcessesMs, 2)}; one refresh is ` +
          `${describeRefreshes(runs)} ms)`,
        frameGapVerdict,
      );

      const jankShares = runs.map(({ conversation }) => jankShareOf(conversation));
      const jankShare = medianOf(jankShares);
      const jankVerdict = evaluateBudget(jankyFramesBudget, jankShare);
      report(
        load,
        `janky frames ${(jankShare * 100).toFixed(3)} % (median of warm launches ` +
          `${runs.map(({ conversation }) => describeJank(conversation)).join(", ")})`,
        jankVerdict,
      );

      const unrasteredCounts = runs.map(({ conversation }) => conversation.unrasteredFrameCount);
      const unrasteredCount = unrasteredCounts.reduce((sum, count) => sum + count, 0);
      const unrasteredVerdict = evaluateBudget(unrasteredFramesBudget, unrasteredCount);
      report(
        load,
        `frames drawn with unrastered content ${String(unrasteredCount)} ` +
          `(warm launches ${unrasteredCounts.join(" + ")} of ` +
          `${runs.map(({ conversation }) => String(conversation.presentedFrameCount)).join(" + ")})`,
        unrasteredVerdict,
      );

      const firstMovedExcessesMs = runs.map(firstMovedFrameExcessMs);
      const firstMovedMs = medianOf(firstMovedExcessesMs);
      const firstMovedVerdict = evaluateBudget(firstMovedFrameBudget, firstMovedMs);
      report(
        load,
        `median first moved frame ${firstMovedMs.toFixed(2)} ms over the plain page's (median ` +
          `of warm launches ${describeFigures(firstMovedExcessesMs, 2)}; ` +
          `${runs.map(describeFirstMovedFrames).join("; ")})`,
        firstMovedVerdict,
      );

      // Gated after all four are printed, so a reading over its ceiling never hides the others.
      gateOnPinnedRunner(
        frameGapVerdict,
        `${frameGapBudget.label}, ${load}: the flings presented frames ` +
          `${frameGapMs.toFixed(2)} ms past one refresh apart at the 95th percentile`,
      );
      gateOnPinnedRunner(
        jankVerdict,
        `${jankyFramesBudget.label}, ${load}: ${(jankShare * 100).toFixed(3)} % of the frames ` +
          "that moved the content were janky",
      );
      gateOnPinnedRunner(
        unrasteredVerdict,
        `${unrasteredFramesBudget.label}, ${load}: ${String(unrasteredCount)} frames presented ` +
          "while the flings moved the content were drawn with unrastered content",
      );
      gateOnPinnedRunner(
        firstMovedVerdict,
        `${firstMovedFrameBudget.label}, ${load}: the median fling first moved the content ` +
          `${firstMovedMs.toFixed(2)} ms later than on a plain page`,
      );
    });
  }

  it("negative control: blurring layers over the conversation miss frames and jank", async () => {
    // Without this the frame-gap and jank clauses could pass over a reader that saw one refresh
    // between frames, and no janky frame, whatever the window drew.
    const { conversation } = await scrollConversationOnce({
      load: "idle",
      flingCount: CONTROL_FLING_COUNT,
      planted: { kind: "blurring-layers", layerCount: BLURRING_LAYER_COUNT },
    });
    const excessMs = frameGapExcessMs(conversation);
    const share = jankShareOf(conversation);
    process.stdout.write(
      `[endurance] scrolling the conversation under ${String(BLURRING_LAYER_COUNT)} blurring ` +
        `layers: presented-frame gap p95 ${excessMs.toFixed(2)} ms past one refresh, ` +
        `${describeJank(conversation)} janky\n`,
    );

    expect(
      evaluateBudget(frameGapBudget, excessMs).withinBudget,
      "flings whose every frame takes the display longer than one refresh to draw passed the " +
        "frame-gap ceiling, so the reading would report green over the frames it exists to catch",
    ).toBe(false);
    expect(
      evaluateBudget(jankyFramesBudget, share).withinBudget,
      "flings whose every frame takes the display longer than one refresh to draw passed the " +
        "jank ceiling, so the reading would report green over the frames it exists to catch",
    ).toBe(false);
  });

  it("negative control: a wheel handler that holds each turn delays the first moved frame", async () => {
    // Without this the first-moved-frame clause could pass over a reader that timed each fling
    // from when the window let its input through rather than from the input itself.
    const run = await scrollConversationOnce({
      load: "idle",
      flingCount: CONTROL_FLING_COUNT,
      planted: { kind: "held-wheel", holdMs: WHEEL_HOLD_MS },
    });
    const excessMs = firstMovedFrameExcessMs(run);
    process.stdout.write(
      `[endurance] scrolling the conversation under a planted ${String(WHEEL_HOLD_MS)} ms wheel ` +
        `handler: median first moved frame ${excessMs.toFixed(2)} ms over the plain page's ` +
        `(${describeFirstMovedFrames(run)})\n`,
    );

    expect(
      evaluateBudget(firstMovedFrameBudget, excessMs).withinBudget,
      "flings whose every wheel turn a handler held for several refreshes passed the first moved " +
        "frame's ceiling, so the reading would report green over the wait it exists to catch",
    ).toBe(false);
  });
});

/**
 * One launch: opens the long conversation, delivers its history, rests the pointer over it, then
 * traces a series of flings up through it, with the four lanes paced across the series when it
 * streams and what a negative control plants when it plants something; then traces the same series
 * over a plain page in the same window.
 */
async function scrollConversationOnce(options: RunOptions): Promise<ConversationRun> {
  return await withLaunchedApp(
    enduranceLaunchOptions(LONG_CONVERSATION_SCENARIO.id),
    async (appUnderTest) => {
      await openRoute(appUnderTest, CONVERSATION_ROUTE, SESSION_SCREEN_SELECTOR);
      await advanceScenario(appUnderTest, LONG_CONVERSATION_HISTORY_END_MS);
      expect(
        await readDeliveredBeatCount(appUnderTest),
        "the clock at the history's end delivered other than the whole history and no lane",
      ).toBe(HISTORY_BEAT_COUNT);
      await appUnderTest.window
        .locator(TRANSCRIPT_ROW_BOX_SELECTOR)
        .first()
        .waitFor({
          state: "attached",
          timeout: appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
        });
      const scroller = appUnderTest.window.locator(CONVERSATION_SCROLLER_SELECTOR);
      const box = await scroller.boundingBox();
      if (box === null) {
        throw new Error(`the conversation (${CONVERSATION_SCROLLER_SELECTOR}) has no box`);
      }
      const pointer = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await appUnderTest.window.mouse.move(pointer.x, pointer.y);
      await waitForIdleWindow(appUnderTest);
      const flingPx = Math.round(
        FLING_SCREEN_HEIGHTS * (await scroller.evaluate((element) => element.clientHeight)),
      );
      if (options.planted !== undefined) {
        await plant(scroller, options.planted);
      }

      const cdpSession = await appUnderTest.application
        .context()
        .newCDPSession(appUnderTest.window);
      await startTraceRecording(cdpSession, SCROLL_TRACE_CATEGORIES);
      const stopDelivery =
        options.load === "idle"
          ? undefined
          : await startPacedDelivery(appUnderTest, {
              leadInMs:
                tickOfBeatCount(FOUR_LANE_STRETCH.fromBeatCount) - LONG_CONVERSATION_HISTORY_END_MS,
              stretchMs:
                tickOfBeatCount(FOUR_LANE_STRETCH.toBeatCount) -
                tickOfBeatCount(FOUR_LANE_STRETCH.fromBeatCount),
              durationMs: seriesDurationMs(flingPx, options.flingCount),
            });
      await flingUpward(cdpSession, pointer, flingPx, options.flingCount);
      const delivery = await stopDelivery?.();
      const conversation = readScrollTrace(await endTraceRecording(cdpSession));
      expectMeasuredSeries(conversation, options.flingCount, "the conversation");
      if (delivery !== undefined) {
        expectFourLanesThroughSeries(delivery);
      }

      const plainPointer = await showPlainPage(appUnderTest, flingPx * (options.flingCount + 2));
      await appUnderTest.window.mouse.move(plainPointer.x, plainPointer.y);
      await waitForIdleWindow(appUnderTest);
      await startTraceRecording(cdpSession, SCROLL_TRACE_CATEGORIES);
      await flingUpward(cdpSession, plainPointer, flingPx, options.flingCount);
      const plainPage = readScrollTrace(await endTraceRecording(cdpSession));
      expectMeasuredSeries(plainPage, options.flingCount, "the plain page");
      return { conversation, plainPage };
    },
  );
}

/**
 * Sends the series as wheel input from the pointer, each fling a gesture of its own, and resolves
 * once the last has ended.
 */
async function flingUpward(
  cdpSession: CDPSession,
  pointer: { readonly x: number; readonly y: number },
  flingPx: number,
  flingCount: number,
): Promise<void> {
  await cdpSession.send("Input.synthesizeScrollGesture", {
    x: Math.round(pointer.x),
    y: Math.round(pointer.y),
    // Positive scrolls up, toward the conversation's first row.
    yDistance: flingPx,
    speed: FLING_SPEED_PX_PER_SECOND,
    gestureSourceType: "mouse",
    preventFling: false,
    repeatCount: flingCount - 1,
    repeatDelayMs: PAUSE_BETWEEN_FLINGS_MS,
  });
}

/**
 * Replaces the window's markup and sheets with a static page of paragraphs and code taller than
 * `requiredTravelPx` past one screen, scrolled to its end as the conversation starts at its tail,
 * and returns the point over its middle.
 */
async function showPlainPage(
  appUnderTest: AppUnderTest,
  requiredTravelPx: number,
): Promise<{ readonly x: number; readonly y: number }> {
  return await appUnderTest.window.evaluate(
    ([travelPx, paragraph, codeEvery, batch]: [number, string, number, number]) => {
      for (const sheet of document.querySelectorAll('style, link[rel="stylesheet"]')) {
        sheet.remove();
      }
      document.adoptedStyleSheets = [];
      const page = document.createElement("div");
      Object.assign(page.style, {
        position: "fixed",
        inset: "0",
        overflowY: "auto",
        background: "#fafaf7",
        color: "#1c1c1a",
        font: "15px/1.5 system-ui, sans-serif",
        padding: "0 24px",
      });
      document.body.replaceChildren(page);
      let blockIndex = 0;
      while (page.scrollHeight < travelPx + 2 * page.clientHeight) {
        for (let index = 0; index < batch; index += 1, blockIndex += 1) {
          const block = document.createElement(
            blockIndex % codeEvery === codeEvery - 1 ? "pre" : "p",
          );
          block.textContent =
            block.tagName === "PRE"
              ? `function step${String(blockIndex)}(value) {\n  return value * 2 + 1;\n}`
              : `${String(blockIndex)}. ${paragraph}`;
          page.append(block);
        }
      }
      page.scrollTop = page.scrollHeight;
      const box = page.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    },
    [requiredTravelPx, PLAIN_PARAGRAPH, PLAIN_CODE_EVERY, PLAIN_PARAGRAPH_BATCH] as [
      number,
      string,
      number,
      number,
    ],
  );
}

/** Asserts the series was what a reading needs: each fling its own gesture, each one moving. */
function expectMeasuredSeries(reading: ScrollReading, flingCount: number, subject: string): void {
  expect(
    reading.gestureCount,
    `the flings over ${subject} reached the window as other than one gesture each`,
  ).toBe(flingCount);
  expect(
    reading.movingGestureCount,
    `some flings over ${subject} moved nothing, so it ran out before the series ended`,
  ).toBe(flingCount);
}

/** Asserts four lanes were mid-turn from the first fling to the last, with beats arriving. */
function expectFourLanesThroughSeries(delivery: PacedDeliveryReading): void {
  expect(
    delivery.beatsAtStart >= FOUR_LANE_STRETCH.fromBeatCount &&
      delivery.beatsAtStop <= FOUR_LANE_STRETCH.toBeatCount,
    `the series ran from beat ${String(delivery.beatsAtStart)} to ` +
      `${String(delivery.beatsAtStop)}, outside the stretch with four lanes mid-turn ` +
      `(${String(FOUR_LANE_STRETCH.fromBeatCount)} to ${String(FOUR_LANE_STRETCH.toBeatCount)})`,
  ).toBe(true);
  expect(
    delivery.beatsAtStop,
    "no beat arrived during the series, so the lanes it scrolled beside were not streaming",
  ).toBeGreaterThan(delivery.beatsAtStart);
}

/** The scenario tick at which `beatCount` beats have been delivered. */
function tickOfBeatCount(beatCount: number): number {
  const beat = LONG_CONVERSATION_SCENARIO.beats[beatCount - 1];
  if (beat === undefined) {
    throw new RangeError(`the long conversation has no beat ${String(beatCount)}`);
  }
  return beat.atMs;
}

/** How long a series takes at the fling speed with its pauses, in milliseconds. */
function seriesDurationMs(flingPx: number, flingCount: number): number {
  return (
    flingCount * ((flingPx / FLING_SPEED_PX_PER_SECOND) * 1000) +
    (flingCount - 1) * PAUSE_BETWEEN_FLINGS_MS
  );
}

/** The 95th-percentile gap between presented frames, less one refresh, in milliseconds. */
function frameGapExcessMs(reading: ScrollReading): number {
  requirePresentedFrameGaps(reading);
  return percentileByNearestRank(reading.presentedFrameGapsMs, 0.95) - reading.refreshIntervalMs;
}

/** The share of the frames that moved the content that Chromium judged janky. */
function jankShareOf(reading: ScrollReading): number {
  return reading.jankyFrameCount / reading.movingFrameCount;
}

/** The conversation's median first moved frame less the plain page's, in milliseconds. */
function firstMovedFrameExcessMs(run: ConversationRun): number {
  return (
    medianOf(run.conversation.firstMovedFrameLatenciesMs) -
    medianOf(run.plainPage.firstMovedFrameLatenciesMs)
  );
}

function describeFigures(figures: readonly number[], fractionDigits: number): string {
  return figures.map((figure) => figure.toFixed(fractionDigits)).join(", ");
}

function describeJank(reading: ScrollReading): string {
  return `${String(reading.jankyFrameCount)} of ${String(reading.movingFrameCount)}`;
}

function describeRefreshes(runs: readonly ConversationRun[]): string {
  return [
    ...new Set(runs.map(({ conversation }) => conversation.refreshIntervalMs.toFixed(3))),
  ].join(" or ");
}

function describeFirstMovedFrames(run: ConversationRun): string {
  return (
    `conversation ${medianOf(run.conversation.firstMovedFrameLatenciesMs).toFixed(2)} ms, ` +
    `plain page ${medianOf(run.plainPage.firstMovedFrameLatenciesMs).toFixed(2)} ms`
  );
}

/** Prints one clause's reading with what the host is, so a pass off the pinned class gates nothing. */
function report(load: ConversationLoad, reading: string, verdict: BudgetVerdict): void {
  process.stdout.write(
    `[endurance] scrolling the conversation, ${load}: ${reading} against a ` +
      `${String(verdict.limitCanonicalValue)} ${verdict.canonicalUnit} ceiling ` +
      `(${(verdict.utilizationFraction * 100).toFixed(1)} % of budget) — ` +
      `${RUNNER_CLASS_DESCRIPTION}\n`,
  );
}

/** Prints the cold first launch's four readings on one line, apart from the gated medians. */
function reportFirstLaunch(load: ConversationLoad, run: ConversationRun): void {
  const { conversation } = run;
  process.stdout.write(
    `[endurance] scrolling the conversation, ${load}: first launch, cold GPU caches, not ` +
      `gated: presented-frame gap p95 ${frameGapExcessMs(conversation).toFixed(2)} ms past one ` +
      `refresh (one refresh is ${conversation.refreshIntervalMs.toFixed(3)} ms); janky frames ` +
      `${(jankShareOf(conversation) * 100).toFixed(3)} % ` +
      `(${describeJank(conversation)}); frames drawn with unrastered content ` +
      `${String(conversation.unrasteredFrameCount)} of ` +
      `${String(conversation.presentedFrameCount)}; median first moved frame ` +
      `${firstMovedFrameExcessMs(run).toFixed(2)} ms over the plain page's ` +
      `(${describeFirstMovedFrames(run)}) — ${RUNNER_CLASS_DESCRIPTION}\n`,
  );
}

/**
 * Compares a timed reading on the pinned runner class only. Not a skip elsewhere: the instrument
 * ran and the figure is printed; only the comparison is withheld, since frame cost off the pinned
 * class describes that machine.
 */
function gateOnPinnedRunner(verdict: BudgetVerdict, failure: string): void {
  if (!isPinnedRunnerClass) {
    return;
  }
  expect(verdict.withinBudget, failure).toBe(true);
}
