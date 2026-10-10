// Tier: endurance. A desktop app is left open for a working day while events arrive, and
// the defects that matter over that span (a listener never unsubscribed, a store array never
// trimmed, a detached DOM node held by a closure) pass every fast tier. This file holds the
// app open over a sustained workload and gates the steady-state heap: the reading after the
// application has settled against the reading after a long stretch of the same work, near zero
// whatever happened in between. It asserts no ceiling on the heap itself; that is
// `heap/at-rest.test.ts`'s budget, and one number must not have two owners.
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
// constructors retained (`heap/snapshot-analysis.ts`).

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { describe, expect, it } from "vitest";

import { withLaunchedApp } from "../helpers/electron/harness.js";
import { fixtureBundleExists } from "../helpers/fixture/bundle.js";
import {
  SCENARIO_FIXTURE_GLOBAL,
  SESSION_DIAGNOSTICS_FIXTURE_GLOBAL,
  TRIPWIRE_FIXTURE_GLOBAL,
} from "#renderer/app/fixture/global-names.js";
import {
  churnOnce,
  ENDURANCE_LAUNCH_OPTIONS,
  CONCURRENT_STREAMING_SESSION_ID,
  readAppliedEventCount,
  readBoundSessionIds,
  readPlayingScenarioId,
} from "./workload.js";
import { readTranscriptWindow } from "./transcript/window-read.js";
import { expectPreciseHeapInstrument, RendererHeapProbe } from "./heap/instrument.js";
import { CONCURRENT_STREAMING_SCENARIO } from "#fixtures/scenarios/concurrent-streaming.js";
// The viewport's own drawn band, so the bound below is not a figure kept in step by hand.
import { TRANSCRIPT_LEADING_BAND_SCREEN_HEIGHTS } from "#renderer/features/transcript/viewport/caps.js";
import { BudgetRegistry } from "../helpers/budget/registry.js";
import { evaluateBudget } from "../helpers/budget/evaluation.js";

const bundleIsBuilt = fixtureBundleExists();

/**
 * How many settle-and-churn cycles the run performs.
 *
 * A cycle costs roughly 50 ms of driven interaction, so this keeps the tier under a minute
 * while a leak of ~40 kB per cycle reaches the `steady-heap-growth` ceiling. A smaller leak is
 * below what this instrument can see.
 */
const CHURN_CYCLE_COUNT = 200;

const registry = BudgetRegistry.load();

/** The growth a run may show and still pass; its row says why that figure. */
const steadyHeapGrowthBudget = registry.requireBudget("steady-heap-growth");

/** What the detached-node reading may reach and still pass; its row says why that figure. */
const detachedNodeRetentionBudget = registry.requireBudget("detached-node-retention");

/**
 * The constructors the snapshot case reads, and why each is in the list.
 *
 * `Detached HTMLDivElement` is the subject: a frame that kept a reference into a tree it
 * unmounted retains the whole detached subtree. `Map` and `Array` are the read control: a
 * snapshot that failed to parse reports the subject as zero, but neither can be zero in a heap
 * that ran a React application. `HTMLDivElement`, the attached one, is the naming control:
 * `"Detached HTMLDivElement"` is a V8/Blink snapshot node name with no other reader in this
 * repository, so a Chromium that spelled DOM nodes differently would leave the subject a
 * permanent zero while the others stayed non-zero. An app with a window open has divs, so a
 * zero there fails the case.
 */
const RETAINED_READING_CONSTRUCTORS = [
  "Detached HTMLDivElement",
  "HTMLDivElement",
  "Map",
  "Array",
] as const;

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

describe.skipIf(!bundleIsBuilt)("endurance — the app held open", () => {
  it("does not grow its steady-state heap across sustained use", async () => {
    await withLaunchedApp(ENDURANCE_LAUNCH_OPTIONS, async (appUnderTest) => {
      // Both readings are taken behind a forced collection: the precision precondition below
      // allocates four megabytes and drops them, which is half this ceiling standing unreachable
      // in front of the baseline and would otherwise be counted as growth or reclaimed mid-run.
      const heapProbe = await RendererHeapProbe.attachTo(appUnderTest);
      try {
        // The workload is named before it is measured: a launch playing another scenario would
        // churn the wrong script and pass every reading. This fails on the regression (no
        // argument, no read, no composition) that makes this tier idle.
        expect(
          await readPlayingScenarioId(appUnderTest),
          `${SCENARIO_FIXTURE_GLOBAL} is not exposed by this ` +
            `build, or the launch did not select a scenario`,
        ).toBe(CONCURRENT_STREAMING_SCENARIO.id);

        // One warm-up cycle before the baseline, so the one-time allocation of the palette, its
        // portal and the settings route is not reported as growth.
        const warmUpCycle = await churnOnce(appUnderTest, SCENARIO_ADVANCE_MS_PER_CYCLE);
        const beatsAfterWarmUp = warmUpCycle.deliveredBeatCount;
        const appliedEventsAfterWarmUp = await readAppliedEventCount(
          appUnderTest,
          CONCURRENT_STREAMING_SESSION_ID,
        );
        // Every figure below is a difference of two heap readings, which the default quantized
        // instrument cannot carry, so the instrument is proved first.
        await expectPreciseHeapInstrument(appUnderTest, heapProbe);

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
          const cycleReading = await churnOnce(appUnderTest, SCENARIO_ADVANCE_MS_PER_CYCLE);
          beatsDelivered = cycleReading.deliveredBeatCount;
          if (transcriptRowsHaveMounted) {
            expect(
              cycleReading.transcriptRowCount,
              `cycle ${String(cycle)} left the transcript holding no ` +
                `row after an earlier cycle had mounted one, so every ` +
                `cycle after it churned a route whose transcript is gone`,
            ).toBeGreaterThan(0);
          }
          if (cycleReading.transcriptRowCount > 0) {
            transcriptRowsHaveMounted = true;
            cyclesWithTranscriptRows += 1;
          }
          if (cycle === Math.floor(CHURN_CYCLE_COUNT / 2)) {
            appliedEventsAtMidRun = await readAppliedEventCount(
              appUnderTest,
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
          appUnderTest,
          CONCURRENT_STREAMING_SESSION_ID,
        );
        process.stdout.write(
          `[endurance] baseline ${String(Math.round(baselineHeapBytes / 1024))} kB, ` +
            `final ${String(Math.round(finalHeapBytes / 1024))} kB, ` +
            `growth ${String(growthKilobytes)} kB over ${String(CHURN_CYCLE_COUNT)} cycles ` +
            `(${String(perCycleBytes)} B/cycle); beats ${String(beatsAfterWarmUp)} → ` +
            `${String(beatsDelivered)} of ` +
            `${String(CONCURRENT_STREAMING_SCENARIO.beats.length)} at ` +
            `${String(SCENARIO_ADVANCE_MS_PER_CYCLE)} ms/cycle; events applied ` +
            `${String(appliedEventsAfterWarmUp)} → ${String(appliedEventsAtMidRun)} → ` +
            `${String(appliedEventCount)}; transcript rows mounted on ` +
            `${String(cyclesWithTranscriptRows)} of ${String(CHURN_CYCLE_COUNT)} cycles\n`,
        );

        // Zero here is the vacuous run: every route wait satisfied by pane chrome, every heap
        // reading taken over an app whose transcript never came up.
        expect(
          cyclesWithTranscriptRows,
          "no churn cycle found a mounted transcript row, so the whole loop churned a route " +
            "whose transcript never drew — the pane's chrome is what satisfied every wait",
        ).toBeGreaterThan(0);

        // The workload moved: the first says the handle was reachable and the script running,
        // the second that it kept running rather than emptying itself into the warm-up cycle.
        expect(beatsAfterWarmUp).not.toBeNull();
        expect(beatsDelivered).not.toBeNull();
        expect(Number(beatsDelivered)).toBeGreaterThan(Number(beatsAfterWarmUp));

        const growthVerdict = evaluateBudget(steadyHeapGrowthBudget, growthBytes);
        expect(
          growthVerdict.withinBudget,
          `${steadyHeapGrowthBudget.label}: ${String(growthBytes)} B against a ` +
            `${String(growthVerdict.limitCanonicalValue)} B ceiling`,
        ).toBe(true);

        // Beats delivered are not events reaching a store. Absence fails here, as for the
        // tripwire registry below, since a build without the handle would make this vacuous.
        expect(
          appliedEventCount,
          `${SESSION_DIAGNOSTICS_FIXTURE_GLOBAL} is not exposed by this build, ` +
            `so nothing can be shown about where the workload's events went`,
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
        // which fails the day the app binds nothing and the tier becomes an idle loop.
        expect(await readBoundSessionIds(appUnderTest)).toContain(CONCURRENT_STREAMING_SESSION_ID);

        // The window is still a window, which the frame's cost depends on. The viewport mounts
        // the visible range plus an overscan either side; an app that mounts a row per
        // admitted event is laying out and painting the whole session every frame.
        //
        // Asserted here because the height chain bounding the transcript is observable only once
        // something overflows it, and this case has driven the script to its end. Every quantity
        // is the viewport's own, not a log quantity read off the document, which is false for
        // any log shorter than twice the screen. `readTranscriptWindow` waits for a mounted row
        // and reads the window either way, so a stalled transcript arrives with figures that say
        // why rather than a bare zero.
        const transcriptWindow = await readTranscriptWindow(
          appUnderTest,
          CONCURRENT_STREAMING_SESSION_ID,
        );
        if (transcriptWindow === null) {
          throw new Error(
            `${SESSION_DIAGNOSTICS_FIXTURE_GLOBAL} reports no transcript viewport ` +
              `for this session, so nothing here says anything about windowing`,
          );
        }
        process.stdout.write(
          `[endurance] transcript window ${String(transcriptWindow.mountedRowCount)} mounted / ` +
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
          "the concurrent-streaming script does not overflow the transcript's " +
            "viewport, so this window is bounded by having nothing to hold — grow " +
            "the scenario in fixtures/scenarios/concurrent-streaming.ts until it does",
        ).toBeGreaterThan(transcriptWindow.viewportClientHeightPx);
        expect(
          transcriptWindow.mountedRowCount,
          "the transcript mounted every row it holds, so it is not " +
            "bounded by the viewport and the whole log is being laid out",
        ).toBeLessThan(transcriptWindow.totalRowCount);
        // Bounded by the box plus its declared band: the rows the box intersects, and either side
        // the rows within the leading side's `TRANSCRIPT_LEADING_BAND_SCREEN_HEIGHTS` of the
        // box's own height, the furthest either side reaches.
        expect(
          transcriptWindow.drawnBandPx,
          "the transcript drew further than its band beyond the rows the box intersects",
        ).toBeLessThanOrEqual(
          transcriptWindow.rangedAgainstClientHeightPx * TRANSCRIPT_LEADING_BAND_SCREEN_HEIGHTS,
        );
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
      await withLaunchedApp(ENDURANCE_LAUNCH_OPTIONS, async (appUnderTest) => {
        const heapProbe = await RendererHeapProbe.attachTo(appUnderTest);
        try {
          expect(
            await readPlayingScenarioId(appUnderTest),
            `${SCENARIO_FIXTURE_GLOBAL} is not exposed by this ` +
              `build, or the launch did not select a scenario`,
          ).toBe(CONCURRENT_STREAMING_SCENARIO.id);

          for (let cycle = 0; cycle < SNAPSHOT_CHURN_CYCLE_COUNT; cycle += 1) {
            await churnOnce(appUnderTest, SCENARIO_ADVANCE_MS_PER_CYCLE);
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
            `[endurance] retained after ${String(SNAPSHOT_CHURN_CYCLE_COUNT)} cycles: ` +
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
            "the snapshot reports no Map at all, so it was " +
              "not written, not parsed, or not this renderer's",
          ).toBeGreaterThan(0);
          expect(instancesOf("Array")).toBeGreaterThan(0);

          // And the naming control: a snapshot can parse and still spell DOM nodes differently,
          // which would make the subject a permanent zero.
          expect(
            instancesOf("HTMLDivElement"),
            "this renderer's snapshot names no attached HTMLDivElement, so the `Detached " +
              "HTMLDivElement` subject below is a name nothing in this heap can match",
          ).toBeGreaterThan(0);

          const detachedBytes = retainedBytesOf("Detached HTMLDivElement");
          expect(
            evaluateBudget(detachedNodeRetentionBudget, detachedBytes).withinBudget,
            `the app is retaining ${String(detachedBytes)} B of detached DOM subtrees across ` +
              "route churn — a frame or a store is holding a reference into a tree it unmounted",
          ).toBe(true);
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
    // The heap is one coarse signal. The app reports invariant breaches through its tripwire
    // registry, and a run this long is the best chance any has to fire. An empty registry is a
    // sharper claim than the heap bound and costs one evaluate. It runs with the clock moving
    // because the breaches worth catching are the ones a delivering scenario causes, such as a
    // beat applied outside the store's chokepoint or a tick that outlived its pane.
    await withLaunchedApp(ENDURANCE_LAUNCH_OPTIONS, async (appUnderTest) => {
      for (let cycle = 0; cycle < CHURN_CYCLE_COUNT; cycle += 1) {
        await churnOnce(appUnderTest, SCENARIO_ADVANCE_MS_PER_CYCLE);
      }
      const firings = await appUnderTest.consolePage.evaluate((globalName: string) => {
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
