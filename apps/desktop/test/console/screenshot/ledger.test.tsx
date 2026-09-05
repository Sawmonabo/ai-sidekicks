// The screenshot tier's ledger arm: the console's signature surface, pinned.
//
// `Spec-023 §Console Test Tiers` puts "the flagship frame at its frozen tick" on
// this tier, and the ledger is what makes that sentence worth anything — the frame
// beside it is chrome around an empty surface until a session is open in it. So
// this file captures the whole console window with the three-lane session loaded,
// in both schemes, plus the one composition no loaded session can reach.
//
// WHY THE WHOLE FRAME AND NOT THE LEDGER ALONE. The claim being pinned is a
// COMPOSITION: the rail, the cast bar, the deck, the chapters, and the attribution
// hues all have to be true at once and in the right relationship to each other. A
// shot cropped to the ledger's own box would still be green the day the rail
// overlapped it.
//
// WHY TWO SCENARIOS AND NOT ONE. `ledger.ts` is three lanes ending in three
// different conditions — one finished behind a rewind boundary, one parked, one
// still streaming — which is the frame a reader has to be able to take in at a
// glance. `ledger-quiet.ts` is a session with a roster and an empty log, and it is
// here because rule 8's EMPTY is the one kind of nothing a scripted stream can
// never reach: every beat a script plays puts a row on screen. An empty state
// nobody can look at is an empty state nobody designed.
//
// WHY THE CAPTURE IS PRECEDED BY ASSERTIONS. A screenshot of an empty ledger is a
// perfectly stable image, so it mints a perfectly stable reference and compares
// green forever. The three claims below the mount — the window is playing the
// scenario this file names, every beat reached it, and rows are on screen — are
// what stop this file pinning a picture of nothing. The quiet arm asserts the
// mirror image, for the same reason in the other direction.
//
// The platform pin, the skip, and the reason it prints are `baseline-platform.ts`'
// — one decision for the whole tier. The tier's fail-closed guard is asserted once,
// in `frame.test.tsx`, and deliberately not repeated here.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "vitest/browser";
import { act } from "@testing-library/react";

import { emulateSystemScheme, renderSettled } from "../console-harness.js";
import {
  OFF_PLATFORM_REASON,
  isOffPinnedPlatform,
  skipOffPinnedPlatform,
} from "./baseline-platform.js";

import {
  ConsoleRoot,
  installMeridianTokens,
} from "../../../src/renderer/src/console/frame/index.js";
import {
  APPLY_COALESCE_MS,
  SCENARIO_FIXTURE_GLOBAL,
} from "../../../src/renderer/src/console/core/index.js";
import { formatRoute } from "../../../src/renderer/src/console/routing/index.js";
import { CONSOLE_SCHEMES } from "../../../src/renderer/src/console/tokens/tokens.js";
import type { ScenarioFixtureHandle } from "../../../src/renderer/src/console/bridge/scenario-selection.js";
import {
  LEDGER_QUIET_SCENARIO,
  LEDGER_QUIET_SCENARIO_ID,
} from "../../../src/renderer/src/console/bridge/scenarios/ledger-quiet.js";
import {
  LEDGER_SCENARIO,
  LEDGER_SCENARIO_ID,
} from "../../../src/renderer/src/console/bridge/scenarios/ledger.js";

/**
 * How many advances the whole script is walked in, and how many drain it.
 *
 * Steps rather than one jump, on `test/console/endurance/console-workload.ts`'
 * reasoning: a beat delivered into a store is applied through a coalescing window
 * armed on the same frozen clock, and the engine emits its beats AFTER moving the
 * clock — so one advance past the last beat delivers every one of them and leaves
 * the last batch queued behind a deadline nothing will ever reach. The drain
 * advances carry that window past its deadline with nothing left to deliver, which
 * is the quiet point a baseline has to be captured at: every beat in, nothing in
 * flight.
 */
const SCENARIO_DELIVERY_STEP_COUNT = 20;
const SCENARIO_DRAIN_STEP_COUNT = 5;

/**
 * What the ledger's mount is waited on, spelled once.
 *
 * The scroll container the workspace mounts on every session route, whether or not
 * that session has rows — so the wait observes the MOUNT rather than the arrival of
 * content, which is what the empty-state capture needs it to observe.
 */
const LEDGER_BODY_SELECTOR = ".meridian-frame__surface .meridian-ledger__body";

/**
 * How long a mount gets before the ledger is called absent.
 *
 * A DEADLINE, and it replaced a fixed count of forty settle turns on 2026-09-02.
 * That count was a wait measured in the wrong unit: a mount is not one turn of work
 * — `ConsoleRoot` opens a durable persistence adapter, the session registry opens a
 * store, and the store initialises from the bridge's own session read, each
 * resolving a promise whose continuation schedules the next — and how many turns
 * those take is a property of the machine, not of the console. Forty of them are
 * about 190 ms, which is enough for a WARM mount and was not enough for a cold one
 * on the pinned `macos-15` runner: the first case in this file refused there while
 * the second, on the same route 1.1 s later, passed.
 *
 * A third of the tier's own timeout, read from the resolved configuration rather
 * than restated, so the two cannot drift apart and the failure names the surface
 * that never mounted instead of timing out the whole test. Two thirds of the budget
 * are left for the script walk and the capture, and 5 s is some twenty-six times
 * the warm mount this file was measured at.
 */
const LEDGER_MOUNT_DEADLINE_MS = Math.floor(server.config.testTimeout / 3);

/**
 * The running scenario's handle, or a throw.
 *
 * A throw rather than a skip, on the endurance tier's posture: a run that could not
 * drive the workload photographed an idle console, and reporting that as a pass is
 * worse than not running at all. The handle is installed by the bridge provider's
 * effect under the same `define` gate as the fixture bridge itself, so it is on the
 * page by the time a settled mount returns.
 */
function requireScenarioControl(): ScenarioFixtureHandle {
  const control = (globalThis as unknown as Record<string, ScenarioFixtureHandle | undefined>)[
    SCENARIO_FIXTURE_GLOBAL
  ];
  if (control === undefined) {
    throw new Error(
      `${SCENARIO_FIXTURE_GLOBAL} is not on this page, so the frozen clock cannot be advanced and ` +
        "any capture taken here would be of a console no scenario ever reached",
    );
  }
  return control;
}

/**
 * Let one turn of the console's own asynchronous work land, inside `act`.
 *
 * A macrotask rather than a microtask flush: the mount path crosses both, and a
 * turn that only drained the microtask queue would return between two halves of one
 * settlement. Inside `act` because every one of those settlements ends in a React
 * state update, and an update that lands outside it settles after the awaited turn
 * rather than before — which React reports as a warning and a capture observes as a
 * frame one commit behind the state it claims to pin.
 */
async function settleOneTurn(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

/** What one opened fixture session hands back: the mount, and what to capture. */
interface LedgerMount {
  readonly container: HTMLElement;
  /** The whole console window — the composition this file pins. */
  readonly frame: Element;
}

/**
 * Open one fixture session at its own route and wait for the ledger to mount.
 *
 * The hash is assigned BEFORE the render rather than navigated to afterwards,
 * because `ConsoleRoot`'s frame store is born on the hash the window opened with —
 * a store that started on the default route publishes that default back over the
 * address on its first pass, which is a navigation this file would then be
 * photographing the tail end of.
 *
 * The wait names the LEDGER's scroll container rather than the frame, and that is
 * the whole reason it is a wait at all: the frame is the window's permanent shell
 * and is on the page from the first commit, so a wait on it returns immediately and
 * hands back a console whose session route has not resolved yet. The workspace
 * mounts the ledger on every session route whether or not that session has rows,
 * so this observes the MOUNT rather than the arrival of content — which is what the
 * empty-state capture needs it to observe.
 */
async function awaitLedgerBody(container: HTMLElement): Promise<void> {
  const deadlineAtMs = Date.now() + LEDGER_MOUNT_DEADLINE_MS;
  while (container.querySelector(LEDGER_BODY_SELECTOR) === null) {
    if (Date.now() >= deadlineAtMs) {
      throw new Error(
        `the session route mounted no ledger body in ${String(LEDGER_MOUNT_DEADLINE_MS)} ms, so ` +
          "this window is not showing the surface this file exists to pin",
      );
    }
    await settleOneTurn();
  }
}

async function openLedgerSession(scenarioId: string, sessionId: string): Promise<LedgerMount> {
  document.location.hash = formatRoute({ kind: "workspace", sessionId });
  const { container } = await renderSettled(<ConsoleRoot scenarioId={scenarioId} />);
  expect(requireScenarioControl().scenarioId).toBe(scenarioId);

  await awaitLedgerBody(container);

  const frame = container.querySelector(".meridian-frame");
  if (frame === null) {
    throw new Error(
      "the console rendered no .meridian-frame element, so there is nothing for this tier to compare",
    );
  }
  return { container, frame };
}

/**
 * Walk the frozen clock to the script's last beat and let the stores settle on it.
 *
 * Each advance is wrapped in `act` because the drain it releases lands in a store
 * whose subscribers are React components: outside `act` those updates settle after
 * the awaited turn rather than before it, which React reports as a warning and a
 * capture observes as a frame one commit behind the state it is claiming to pin.
 *
 * Returns the delivered-beat count so the caller can assert the session it is about
 * to photograph actually has content.
 */
async function playToFrozenTick(lastBeatAtMs: number): Promise<number> {
  const control = requireScenarioControl();
  // At least one coalescing window per step, so every step also drains the batch
  // the step before it delivered — a shorter step would deliver beats no advance
  // in this loop ever released.
  const stepMs = Math.max(
    APPLY_COALESCE_MS + 1,
    Math.ceil(lastBeatAtMs / SCENARIO_DELIVERY_STEP_COUNT),
  );
  for (let step = 0; step < SCENARIO_DELIVERY_STEP_COUNT + SCENARIO_DRAIN_STEP_COUNT; step += 1) {
    await act(async () => {
      control.advance(stepMs);
      await Promise.resolve();
    });
  }
  return control.deliveredBeatCount();
}

beforeEach(() => {
  document.location.hash = "";
  installMeridianTokens(document);
});

afterEach(async () => {
  // Leave the emulation off, so a later file's baseline is not captured under
  // whichever scheme this one finished in.
  await emulateSystemScheme("light");
});

describe("screenshot — the ledger under the three-lane scenario", () => {
  // Said once at collection, on the one channel the terminal reporter forwards.
  // Without it an off-platform run reports a skipped count and nothing else, which
  // a reader cannot tell from a tier that was quietly switched off.
  if (isOffPinnedPlatform) {
    console.warn(OFF_PLATFORM_REASON);
  }

  for (const scheme of CONSOLE_SCHEMES) {
    it(`renders the ${scheme} scheme at the script's last beat`, async (context) => {
      skipOffPinnedPlatform(context);
      await emulateSystemScheme(scheme);
      const { container, frame } = await openLedgerSession(
        LEDGER_SCENARIO_ID,
        LEDGER_SCENARIO.sessionId,
      );

      const deliveredBeatCount = await playToFrozenTick(LEDGER_SCENARIO.beats.at(-1)?.atMs ?? 0);
      expect(
        deliveredBeatCount,
        "the whole script has to be in before the tick is frozen: a capture taken mid-script pins " +
          "a session that is still arriving, and the reference it mints moves with the loop above",
      ).toBe(LEDGER_SCENARIO.beats.length);

      // Rows on screen, not merely events in a store. The projection, the window
      // fold, and the viewport's reconcile all sit between the two, and a capture
      // is only worth pinning once every one of them has run.
      expect(
        container.querySelectorAll(".meridian-ledger-row").length,
        "no ledger row reached the document, so this capture would pin an empty feed",
      ).toBeGreaterThan(0);

      await expect(frame).toMatchScreenshot(`ledger-three-lanes-${scheme}`);
    });
  }
});

describe("screenshot — the ledger's empty state", () => {
  it("renders a session that has a roster and no log", async (context) => {
    // One scheme rather than two, on `frame.test.tsx`'s reasoning for the palette:
    // both palettes are already pinned by the pair above, and what this capture
    // exists for is the copy and the shape of the absence, neither of which the
    // scheme decides.
    skipOffPinnedPlatform(context);
    await emulateSystemScheme("light");
    const { container, frame } = await openLedgerSession(
      LEDGER_QUIET_SCENARIO_ID,
      LEDGER_QUIET_SCENARIO.sessionId,
    );

    // The negative control for the pair above, and the positive one for this
    // capture: the empty state is reachable only because this scenario's script is
    // empty, so a row here would mean the fixture picker had handed over the wrong
    // session and the "empty state" reference was a picture of a loaded one.
    expect(container.querySelectorAll(".meridian-ledger-row")).toHaveLength(0);
    expect(container.textContent).toContain("Nothing has happened in this session yet.");

    await expect(frame).toMatchScreenshot("ledger-quiet-light");
  });
});

describe("the ledger mount wait", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // The negative control for the deadline above. Every capture in this file is
  // taken through a wait that reports an absent ledger, and a wait that cannot
  // report one is a wait that reports every surface as present — so this drives
  // the real `awaitLedgerBody` against a route that mounts no ledger body and
  // asserts the refusal, which is the one path the three captures never take.
  //
  // Deliberately NOT platform-skipped: what it pins is the wait, and the wait does
  // not vary by platform. The three captures skip off the baseline platform
  // because their references do.
  //
  // The clock is faked rather than waited out, and only `Date` is faked: the wait
  // reads the clock and settles turns on real macrotasks, so faking the timers as
  // well would suspend the very turns the loop is counting on and the refusal would
  // never be reached. The system time is pushed past the deadline after the loop
  // has yielded on its first turn, which is what makes this run in a millisecond
  // rather than in the five seconds the deadline names — and what proves it is the
  // DEADLINE that refuses, since no number of turns passed in between.
  it("refuses a route that mounts no ledger body, on the deadline rather than on a turn count", async () => {
    document.location.hash = formatRoute({ kind: "sessions" });
    const { container } = await renderSettled(<ConsoleRoot scenarioId={LEDGER_SCENARIO_ID} />);
    expect(
      container.querySelector(LEDGER_BODY_SELECTOR),
      "the session directory mounted a ledger body, so this control is asserting the refusal of a " +
        "route that in fact reaches the surface and would pass whatever the wait did",
    ).toBeNull();

    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAtMs = Date.now();
    const pending = awaitLedgerBody(container);
    vi.setSystemTime(startedAtMs + LEDGER_MOUNT_DEADLINE_MS + 1);

    await expect(pending).rejects.toThrow(
      `the session route mounted no ledger body in ${String(LEDGER_MOUNT_DEADLINE_MS)} ms`,
    );
  });
});
