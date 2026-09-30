// Tier: endurance. A desktop console is left open for a working day while events arrive, and
// the defects that matter over that span (a listener never unsubscribed, a store array never
// trimmed, a detached DOM node held by a closure) pass every fast tier. This file holds the
// console open over a sustained workload and gates the steady-state heap: the reading after the
// application has settled against the reading after a long stretch of the same work, near zero
// whatever happened in between. It asserts no ceiling on the heap itself; that is
// `heap-at-rest.test.ts`'s budget, and one number must not have two owners.
//
// The workload is the fixture bridge's scenario engine: deterministic, driving the store paths a
// daemon would, on a frozen clock. That clock does not advance itself, so the run names the
// scenario (`withLaunchedApp({ scenarioId }, ...)`, passed as `--fixture`; a launch naming none
// plays none) and advances the clock every churn cycle through the fixture-only handle, by an
// amount derived from the script's span so the run walks it about once. Delivered beats are read
// back and asserted to grow.
//
// The session store is read the same way, through the subscription and apply chokepoint a
// daemon's events take. The applied-event count is read after warm-up, half way and at the end
// and asserted strictly increasing, since one end-to-end comparison would pass over a run that
// delivered its whole script in the warm-up and then idled, which is where a leak hides.
//
// The loop also observes the transcript each cycle: the route wait names the transcript pane,
// whose chrome mounts whether or not a row draws. Rows appear part-way through, so the claim is
// that once a cycle found a mounted row no later cycle finds the transcript emptied, and the
// count of cycles that found one is asserted non-zero. Absence of the diagnostics handle fails,
// never skips. The last case snapshots the renderer over the same workload and reads what named
// constructors retained (`heap-snapshot-analysis.ts`).

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { describe, expect, it } from "vitest";

import { withLaunchedApp } from "../helpers/electron-harness.js";
import { fixtureBundleExists } from "../helpers/fixture-bundle.js";
import {
  SCENARIO_FIXTURE_GLOBAL,
  SESSION_DIAGNOSTICS_FIXTURE_GLOBAL,
  TRIPWIRE_FIXTURE_GLOBAL,
} from "@renderer/app/fixture-global-names.js";
import {
  churnOnce,
  ENDURANCE_LAUNCH_OPTIONS,
  CONCURRENT_STREAMING_SESSION_ID,
  openConcurrentStreamingSessionRoute,
  openSettingsRoute,
  readAppliedEventCount,
  readBoundSessionIds,
  readPlayingScenarioId,
  SETTINGS_SCREEN_SELECTOR,
  SESSION_SCREEN_SELECTOR,
} from "./endurance-workload.js";
import { readTranscriptWindow } from "./transcript-window-read.js";
import { expectPreciseHeapInstrument, RendererHeapProbe } from "./heap-instrument.js";
import { CONCURRENT_STREAMING_SCENARIO } from "../../fixtures/scenarios/concurrent-streaming.js";
// The viewport's own overscan, so the bound below is not a figure kept in step by hand.
import { TRANSCRIPT_OVERSCAN_ROWS } from "@renderer/features/transcript/viewport/viewport-constants.js";

const bundleIsBuilt = fixtureBundleExists();

/**
 * How many settle-and-churn cycles the run performs.
 *
 * A cycle costs roughly 50 ms of driven interaction, so this keeps the tier under a minute
 * while a leak of ~40 kB per cycle reaches the ceiling below. A smaller leak is below what this
 * instrument can see.
 */
const CHURN_CYCLE_COUNT = 200;

/**
 * The growth a run may show and still pass.
 *
 * Not zero, because V8 keeps caches, code objects and deoptimization data alive across a run.
 * Not a percentage, because a percentage of a large baseline is a large absolute allowance and
 * a leak's size does not depend on the application's.
 */
const STEADY_HEAP_GROWTH_CEILING_BYTES = 8 * 1024 * 1024;

/**
 * The constructors the snapshot case reads, and why each is in the list.
 *
 * `Detached HTMLDivElement` is the subject: a frame that kept a reference into a tree it
 * unmounted retains the whole detached subtree. `Map` and `Array` are the read control: a
 * snapshot that failed to parse reports the subject as zero, but neither can be zero in a heap
 * that ran a React application. `HTMLDivElement`, the attached one, is the naming control:
 * `"Detached HTMLDivElement"` is a V8/Blink snapshot node name with no other reader in this
 * repository, so a Chromium that spelled DOM nodes differently would leave the subject a
 * permanent zero while the others stayed non-zero. A console with a window open has divs, so a
 * zero there fails the case.
 */
const RETAINED_READING_CONSTRUCTORS = [
  "Detached HTMLDivElement",
  "HTMLDivElement",
  "Map",
  "Array",
] as const;

/**
 * What the detached-node reading may reach and still pass: four megabytes.
 *
 * Well above the transient detachment a React unmount leaves for the next collection and far
 * below a frame that retained one route's subtree per cycle. Not derived from
 * `STEADY_HEAP_GROWTH_CEILING_BYTES`: that bounds a difference of two readings over the whole
 * application, this an absolute retention of one constructor.
 */
const DETACHED_NODE_RETENTION_CEILING_BYTES = 4 * 1024 * 1024;

/**
 * How many cycles the snapshot case churns.
 *
 * A quarter of the gate case's, its own number because the subject is retention per mount and
 * unmount rather than a slope. At this many cycles the smallest per-cycle retention the ceiling
 * can see is about 80 kB; a full-length run would cost a minute of runner time for a sharper
 * figure than the ceiling is written to.
 */
const SNAPSHOT_CHURN_CYCLE_COUNT = Math.ceil(CHURN_CYCLE_COUNT / 4);

/**
 * How far the frozen clock moves on each churn cycle.
 *
 * Derived from the script so it stays right as the scenario grows: the run's total advance is
 * about the script's span, which spreads its beats across the cycles instead of delivering all
 * of them in the first, where the growth assertion could never fire again.
 */
const SCENARIO_ADVANCE_MS_PER_CYCLE = Math.max(
  1,
  Math.ceil((CONCURRENT_STREAMING_SCENARIO.beats.at(-1)?.atMs ?? 0) / CHURN_CYCLE_COUNT),
);

describe.skipIf(!bundleIsBuilt)("endurance — the console held open", () => {
  // Proves every reading below describes a console that navigated. A churn cycle is two route
  // changes, and each must be observed before the next hash is assigned: waiting on the app's
  // permanent chrome returns at once, so the second assignment could land before React had
  // mounted the first destination. The locators asserted route-exclusive here are the two
  // constants `churnOnce` waits on, so a wait re-pointed at an element both routes render fails
  // on the two absence checks below.
  it("waits on a screen that only its own destination renders", async () => {
    await withLaunchedApp(ENDURANCE_LAUNCH_OPTIONS, async (consoleApplication) => {
      const consoleWindow = consoleApplication.window;

      // `openSettingsRoute` already waited for its own locator, so the positive half is the
      // wait itself. Asserted here is the half a wait cannot make: the other route's locator is
      // absent, which a locator naming the permanent chrome could never satisfy.
      await openSettingsRoute(consoleApplication);
      expect(await consoleWindow.locator(SETTINGS_SCREEN_SELECTOR).count()).toBeGreaterThan(0);
      expect(
        await consoleWindow.locator(SESSION_SCREEN_SELECTOR).count(),
        "the session screen wait is satisfied on the settings route, so a churn cycle never observes the transition into the session screen",
      ).toBe(0);

      await openConcurrentStreamingSessionRoute(consoleApplication);
      expect(await consoleWindow.locator(SESSION_SCREEN_SELECTOR).count()).toBeGreaterThan(0);
      expect(
        await consoleWindow.locator(SETTINGS_SCREEN_SELECTOR).count(),
        "the settings wait is satisfied on the session route, so a churn cycle never observes the transition into settings",
      ).toBe(0);
    });
  });

  it("does not grow its steady-state heap across sustained use", async () => {
    await withLaunchedApp(ENDURANCE_LAUNCH_OPTIONS, async (consoleApplication) => {
      // Both readings are taken behind a forced collection: the precision precondition below
      // allocates four megabytes and drops them, which is half this ceiling standing unreachable
      // in front of the baseline and would otherwise be counted as growth or reclaimed mid-run.
      const heapProbe = await RendererHeapProbe.attachTo(consoleApplication);
      try {
        // The workload is named before it is measured: a launch playing another scenario would
        // churn the wrong script and pass every reading. This fails on the regression (no
        // argument, no read, no composition) that makes this tier idle.
        expect(
          await readPlayingScenarioId(consoleApplication),
          `${SCENARIO_FIXTURE_GLOBAL} is not exposed by this build, or the launch did not select a scenario`,
        ).toBe(CONCURRENT_STREAMING_SCENARIO.id);

        // One warm-up cycle before the baseline, so the one-time allocation of the palette, its
        // portal and the settings route is not reported as growth.
        const warmUpCycle = await churnOnce(consoleApplication, SCENARIO_ADVANCE_MS_PER_CYCLE);
        const beatsAfterWarmUp = warmUpCycle.deliveredBeatCount;
        const appliedEventsAfterWarmUp = await readAppliedEventCount(
          consoleApplication,
          CONCURRENT_STREAMING_SESSION_ID,
        );
        // Every figure below is a difference of two heap readings, which the default quantized
        // instrument cannot carry, so the instrument is proved first.
        await expectPreciseHeapInstrument(consoleApplication, heapProbe);

        const baselineHeapBytes = await heapProbe.readSettledBytes();

        let beatsDelivered = beatsAfterWarmUp;
        let appliedEventsAtMidRun: number | null = null;
        // Counted per cycle: rows appear part-way through, so once mounted a cycle must never
        // find the transcript emptied, and the count says the loop reached that state at all.
        // The session screen wait names only the pane chrome, so nothing else here observes the
        // transcript the heap reading is about.
        let cyclesWithTranscriptRows = 0;
        let transcriptRowsHaveMounted = false;
        for (let cycle = 0; cycle < CHURN_CYCLE_COUNT; cycle += 1) {
          const cycleReading = await churnOnce(consoleApplication, SCENARIO_ADVANCE_MS_PER_CYCLE);
          beatsDelivered = cycleReading.deliveredBeatCount;
          if (transcriptRowsHaveMounted) {
            expect(
              cycleReading.transcriptRowCount,
              `cycle ${String(cycle)} left the transcript holding no row after an earlier cycle had mounted one, so every cycle after it churned a route whose transcript is gone`,
            ).toBeGreaterThan(0);
          }
          if (cycleReading.transcriptRowCount > 0) {
            transcriptRowsHaveMounted = true;
            cyclesWithTranscriptRows += 1;
          }
          if (cycle === Math.floor(CHURN_CYCLE_COUNT / 2)) {
            appliedEventsAtMidRun = await readAppliedEventCount(
              consoleApplication,
              CONCURRENT_STREAMING_SESSION_ID,
            );
          }
        }

        const finalHeapBytes = await heapProbe.readSettledBytes();
        const growthBytes = finalHeapBytes - baselineHeapBytes;

        // Reported before the assertion so a passing run still records the number.
        const growthKilobytes = Math.round(growthBytes / 1024);
        const perCycleBytes = Math.round(growthBytes / CHURN_CYCLE_COUNT);
        const appliedEventCount = await readAppliedEventCount(
          consoleApplication,
          CONCURRENT_STREAMING_SESSION_ID,
        );
        process.stdout.write(
          `[console-endurance] baseline ${String(Math.round(baselineHeapBytes / 1024))} kB, ` +
            `final ${String(Math.round(finalHeapBytes / 1024))} kB, ` +
            `growth ${String(growthKilobytes)} kB over ${String(CHURN_CYCLE_COUNT)} cycles ` +
            `(${String(perCycleBytes)} B/cycle); beats ${String(beatsAfterWarmUp)} → ` +
            `${String(beatsDelivered)} of ${String(CONCURRENT_STREAMING_SCENARIO.beats.length)} at ` +
            `${String(SCENARIO_ADVANCE_MS_PER_CYCLE)} ms/cycle; events applied ` +
            `${String(appliedEventsAfterWarmUp)} → ${String(appliedEventsAtMidRun)} → ` +
            `${String(appliedEventCount)}; transcript rows mounted on ` +
            `${String(cyclesWithTranscriptRows)} of ${String(CHURN_CYCLE_COUNT)} cycles\n`,
        );

        // Zero here is the vacuous run: every route wait satisfied by pane chrome, every heap
        // reading taken over a console whose transcript never came up.
        expect(
          cyclesWithTranscriptRows,
          "no churn cycle found a mounted transcript row, so the whole loop churned a route whose transcript never drew — the pane's chrome is what satisfied every wait",
        ).toBeGreaterThan(0);

        // The workload moved: the first says the handle was reachable and the script running,
        // the second that it kept running rather than emptying itself into the warm-up cycle.
        expect(beatsAfterWarmUp).not.toBeNull();
        expect(beatsDelivered).not.toBeNull();
        expect(Number(beatsDelivered)).toBeGreaterThan(Number(beatsAfterWarmUp));

        expect(growthBytes).toBeLessThanOrEqual(STEADY_HEAP_GROWTH_CEILING_BYTES);

        // Beats delivered are not events reaching a store. Absence fails here, as for the
        // tripwire registry below, since a build without the handle would make this vacuous.
        expect(
          appliedEventCount,
          `${SESSION_DIAGNOSTICS_FIXTURE_GLOBAL} is not exposed by this build, so nothing can be shown about where the workload's events went`,
        ).not.toBeNull();
        expect(appliedEventsAfterWarmUp).not.toBeNull();
        expect(appliedEventsAtMidRun).not.toBeNull();

        // The events kept arriving for the whole run: still delivering at the half-way point,
        // and still at the end.
        expect(
          Number(appliedEventsAtMidRun),
          "the scenario stopped delivering into the store before the run was half over",
        ).toBeGreaterThan(Number(appliedEventsAfterWarmUp));
        expect(
          Number(appliedEventCount),
          "the scenario stopped delivering into the store part-way through the run",
        ).toBeGreaterThan(Number(appliedEventsAtMidRun));

        // And they reached a store through a real subscription rather than a side channel,
        // which fails the day the console binds nothing and the tier becomes an idle loop.
        expect(await readBoundSessionIds(consoleApplication)).toContain(
          CONCURRENT_STREAMING_SESSION_ID,
        );

        // The window is still a window, which the frame's cost depends on. The viewport mounts
        // the visible range plus an overscan either side; a console that mounts a row per
        // admitted event is laying out and painting the whole session every frame.
        //
        // Asserted here because the height chain bounding the transcript is observable only once
        // something overflows it, and this case has driven the script to its end. Every quantity
        // is the viewport's own, not a log quantity read off the document, which is false for
        // any log shorter than twice the screen. `readTranscriptWindow` waits for a mounted row
        // and reads the window either way, so a stalled transcript arrives with figures that say
        // why rather than a bare zero.
        const transcriptWindow = await readTranscriptWindow(
          consoleApplication,
          CONCURRENT_STREAMING_SESSION_ID,
        );
        expect(
          transcriptWindow,
          `${SESSION_DIAGNOSTICS_FIXTURE_GLOBAL} reports no transcript viewport for this session, so nothing here says anything about windowing`,
        ).not.toBeNull();
        if (transcriptWindow === null) {
          throw new Error("unreachable: the assertion above fails first");
        }
        process.stdout.write(
          `[console-endurance] transcript window ${String(transcriptWindow.mountedRowCount)} mounted / ` +
            `${String(transcriptWindow.virtualItemCount)} windowed / ` +
            `${String(transcriptWindow.visibleRowCount)} visible of ` +
            `${String(transcriptWindow.totalRowCount)} rows ` +
            `(${String(transcriptWindow.indexableRowCount)} indexable), viewport ` +
            `${String(transcriptWindow.viewportClientHeightPx)} px ` +
            `(ranged against ${String(transcriptWindow.rangedAgainstClientHeightPx)} px) showing ` +
            `${String(transcriptWindow.viewportScrollHeightPx)} px of a ` +
            `${String(transcriptWindow.totalContentHeightPx)} px log\n`,
        );

        expect(
          transcriptWindow.mountedRowCount,
          "the transcript mounted no rows at all, so nothing here says anything about windowing",
        ).toBeGreaterThan(0);
        // The subject exists at all: a log that fits its box is windowed vacuously. The failure
        // is the workload's, since the fixture script is what has to grow until it overflows.
        expect(
          transcriptWindow.viewportScrollHeightPx,
          "the concurrent-streaming script does not overflow the transcript's viewport, so this window is bounded by having nothing to hold — grow the scenario in fixtures/scenarios/concurrent-streaming.ts until it does",
        ).toBeGreaterThan(transcriptWindow.viewportClientHeightPx);
        expect(
          transcriptWindow.mountedRowCount,
          "the transcript mounted every row it holds, so it is not bounded by the viewport and the whole log is being laid out",
        ).toBeLessThan(transcriptWindow.totalRowCount);
        // Bounded by the box plus its declared overscan: the rows the box intersects, and
        // `TRANSCRIPT_OVERSCAN_ROWS` either side.
        expect(
          transcriptWindow.mountedRowCount - transcriptWindow.visibleRowCount,
          "the transcript mounted more than its overscan beyond the rows the box intersects",
        ).toBeLessThanOrEqual(2 * TRANSCRIPT_OVERSCAN_ROWS);
      } finally {
        // Detached before the window closes: detaching from a closed application raises and
        // would replace whatever the body was failing on with a teardown error.
        await heapProbe.detach();
      }
    });
  });

  it("names what the run's heap is holding, and bounds the detached nodes in it", async () => {
    const snapshotDirectory = await mkdtemp(join(tmpdir(), "sidekicks-endurance-heap-"));
    const snapshotPath = join(snapshotDirectory, "renderer.heapsnapshot");
    try {
      await withLaunchedApp(ENDURANCE_LAUNCH_OPTIONS, async (consoleApplication) => {
        const heapProbe = await RendererHeapProbe.attachTo(consoleApplication);
        try {
          expect(
            await readPlayingScenarioId(consoleApplication),
            `${SCENARIO_FIXTURE_GLOBAL} is not exposed by this build, or the launch did not select a scenario`,
          ).toBe(CONCURRENT_STREAMING_SCENARIO.id);

          for (let cycle = 0; cycle < SNAPSHOT_CHURN_CYCLE_COUNT; cycle += 1) {
            await churnOnce(consoleApplication, SCENARIO_ADVANCE_MS_PER_CYCLE);
          }

          // Collects first, then streams the snapshot to a file, over the same DevTools session
          // every reading in this tier uses.
          await heapProbe.captureSnapshotTo(snapshotPath);
          const readings = await heapProbe.readRetainedByConstructor(snapshotPath, [
            ...RETAINED_READING_CONSTRUCTORS,
          ]);
          const retainedBytesOf = (constructorName: string): number =>
            readings.find((reading) => reading.constructorName === constructorName)
              ?.retainedByteCount ?? 0;
          const instancesOf = (constructorName: string): number =>
            readings.find((reading) => reading.constructorName === constructorName)
              ?.instanceCount ?? 0;

          // Reported whether or not it passes, so a reviewer can watch a margin close.
          process.stdout.write(
            `[console-endurance] retained after ${String(SNAPSHOT_CHURN_CYCLE_COUNT)} cycles: ` +
              readings
                .map(
                  (reading) =>
                    `${reading.constructorName} ${String(reading.instanceCount)} \u00d7 ` +
                    `${String(Math.round(reading.retainedByteCount / 1024))} kB`,
                )
                .join(", ") +
              "\n",
          );

          // The control, first: a snapshot never written or parsed reports every constructor as
          // absent, and the subject's bound below would pass over it.
          expect(
            instancesOf("Map"),
            "the snapshot reports no Map at all, so it was not written, not parsed, or not this renderer's",
          ).toBeGreaterThan(0);
          expect(instancesOf("Array")).toBeGreaterThan(0);

          // And the naming control: a snapshot can parse and still spell DOM nodes differently,
          // which would make the subject a permanent zero.
          expect(
            instancesOf("HTMLDivElement"),
            "this renderer's snapshot names no attached HTMLDivElement, so the `Detached HTMLDivElement` subject below is a name nothing in this heap can match",
          ).toBeGreaterThan(0);

          expect(
            retainedBytesOf("Detached HTMLDivElement"),
            "the console is retaining detached DOM subtrees across route churn — a frame or a store is holding a reference into a tree it unmounted",
          ).toBeLessThanOrEqual(DETACHED_NODE_RETENTION_CEILING_BYTES);
        } finally {
          await heapProbe.detach();
        }
      });
    } finally {
      // The snapshot is larger than the heap it describes, so the caller removes it.
      await rm(snapshotDirectory, { recursive: true, force: true });
    }
  });

  it("leaves no tripwire firing after sustained use", async () => {
    // The heap is one coarse signal. The console reports invariant breaches through its tripwire
    // registry, and a run this long is the best chance any has to fire. An empty registry is a
    // sharper claim than the heap bound and costs one evaluate. It runs with the clock moving
    // because the breaches worth catching are the ones a delivering scenario causes, such as a
    // beat applied outside the store's chokepoint or a tick that outlived its pane.
    await withLaunchedApp(ENDURANCE_LAUNCH_OPTIONS, async (consoleApplication) => {
      for (let cycle = 0; cycle < CHURN_CYCLE_COUNT; cycle += 1) {
        await churnOnce(consoleApplication, SCENARIO_ADVANCE_MS_PER_CYCLE);
      }
      const firings = await consoleApplication.window.evaluate((globalName: string) => {
        const registry = (
          globalThis as unknown as Record<string, { reports(): readonly unknown[] } | undefined>
        )[globalName];
        return registry === undefined ? null : [...registry.reports()];
      }, TRIPWIRE_FIXTURE_GLOBAL);

      // Absence is a failure, not a reason to skip: a build that did not expose the registry
      // would pass while checking nothing. The property name is imported from the renderer
      // module that sets it, so the two sides cannot drift into a vacuous pass.
      expect(firings, `${TRIPWIRE_FIXTURE_GLOBAL} is not exposed by this build`).not.toBeNull();
      expect(firings).toStrictEqual([]);
    });
  });
});
