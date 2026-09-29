// The screenshot tier's transcript arm: the app's signature view, captured.
//
// Two captures. The whole window with the concurrent-streaming session loaded, in both
// schemes: its claim is a composition (the rail, the session header, the pane layout,
// the run groups and the agent hues all true at once), which a shot cropped to the
// transcript's box would miss. It is that scenario because it carries every signature
// state at one tick: several runs streaming in their own hues, an approval asked and
// granted mid-stream, a run parked on a provider quota with its reset instant, a child
// run threaded to the turn that spawned it, and the committed cost figure.
//
// And the empty-session transcript's own region: a session with a roster and an empty
// log is the one kind of nothing a scripted stream can never reach, and its claim is
// the copy and shape of an absence, a single view rather than a composition.
//
// Each capture is preceded by assertions, because a screenshot of an empty transcript
// is a perfectly stable image. The loaded arm asserts the window plays the named
// scenario, every beat reached it, and rows are on screen; the empty arm asserts no beat
// reached it and the empty sentence is on screen, which a mount alone cannot show,
// since a window whose first read has not landed draws loading shells.
//
// `settled-capture.ts` owns the mechanism: every capture is written into the gitignored
// `__screenshots__/` and compared against nothing, so this file gates on whether each
// view can be captured at all.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  awaitSessionRouteMounted,
  emulateSystemScheme,
  renderSettled,
  resetDurableAppState,
  SESSION_ROUTE_BODY_SELECTOR,
  SESSION_ROUTE_MOUNT_DEADLINE_MS,
} from "../helpers/app-harness.js";
import { requireScenarioControl, walkScenarioToFrozenTick } from "./scenario-clock.js";
import { requireCapturedElement } from "./captured-element.js";

import { createFixtureComposition } from "@renderer/app/fixture-composition.js";
import { AppProviders } from "@renderer/app/providers.js";
import { installMeridianTokens } from "@renderer/app/token-installation.js";
import { formatRoute } from "@renderer/routing/routes.js";
import { COLOR_SCHEMES } from "@renderer/styles/tokens.js";
import {
  EMPTY_SESSION_SCENARIO,
  EMPTY_SESSION_SCENARIO_ID,
} from "../../fixtures/scenarios/empty-session.js";
import {
  CONCURRENT_STREAMING_SCENARIO,
  CONCURRENT_STREAMING_SCENARIO_ID,
} from "../../fixtures/scenarios/concurrent-streaming.js";
import { TRANSCRIPT_STATES_SCENARIO_ID } from "../../fixtures/scenarios/transcript-states.js";
import { captureSettled } from "./settled-capture.js";

/** What one opened fixture session hands back: the mount, and what to capture. */
interface TranscriptMount {
  readonly container: HTMLElement;
  /** The whole window: the composition the concurrent-streaming pair captures. */
  readonly frame: Element;
  /**
   * The transcript's own region — what the quiet arm pins.
   *
   * The SAME element the mount wait above observes, rather than a second selector
   * for the same box: a capture element resolved independently of the wait could
   * name an element the wait never guaranteed had arrived, and the two would drift.
   */
  readonly transcriptBody: Element;
}

/**
 * Open one fixture session at its own route and wait for it to finish arriving.
 *
 * The hash is assigned BEFORE the render rather than navigated to afterwards,
 * because `AppProviders`'s frame store is born on the hash the window opened with —
 * a store that started on the default route publishes that default back over the
 * address on its first pass, which is a navigation this file would then be
 * photographing the tail end of.
 *
 * The wait is the harness's, and it names the TRANSCRIPT's scroll container rather than
 * the frame, which is the whole reason it is a wait at all: the frame is the
 * window's permanent shell and is on the page from the first commit, so a wait on it
 * hands back a console whose session route has not resolved yet. It observes the
 * MOUNT rather than the arrival of content, which is what the empty-state capture
 * needs it to observe.
 */
async function openTranscriptSession(
  scenarioId: string,
  sessionId: string,
): Promise<TranscriptMount> {
  document.location.hash = formatRoute({ kind: "session", sessionId });
  const { container } = await renderSettled(
    <AppProviders composition={createFixtureComposition(scenarioId)} />,
  );
  expect(requireScenarioControl().scenarioId).toBe(scenarioId);

  await awaitSessionRouteMounted(container);

  return {
    container,
    frame: requireCapturedElement(container, ".meridian-frame"),
    transcriptBody: requireCapturedElement(container, SESSION_ROUTE_BODY_SELECTOR),
  };
}

beforeEach(async () => {
  // The database this window opens outlives the file that opened it: browser mode
  // gives every file in a session one origin, so an arrangement another file
  // persisted would be restored into these mounts and photographed here.
  await resetDurableAppState();
  document.location.hash = "";
  installMeridianTokens(document);
});

afterEach(async () => {
  // Leave the emulation off, so a later file's baseline is not captured under
  // whichever scheme this one finished in.
  await emulateSystemScheme("light");
});

describe("screenshot — the app under the concurrent-streaming scenario", () => {
  for (const scheme of COLOR_SCHEMES) {
    it(`renders the ${scheme} scheme at the script's last beat`, async () => {
      await emulateSystemScheme(scheme);
      const { container, frame } = await openTranscriptSession(
        CONCURRENT_STREAMING_SCENARIO_ID,
        CONCURRENT_STREAMING_SCENARIO.sessionId,
      );

      const deliveredBeatCount = await walkScenarioToFrozenTick(
        CONCURRENT_STREAMING_SCENARIO.beats.at(-1)?.atMs ?? 0,
      );
      expect(
        deliveredBeatCount,
        "the whole script has to be in before the tick is frozen: a capture taken mid-script pins " +
          "a session that is still arriving, and the capture it writes moves with the loop above",
      ).toBe(CONCURRENT_STREAMING_SCENARIO.beats.length);

      // Rows on screen, not merely events in a store. The projection, the window
      // fold, and the viewport's reconcile all sit between the two, and a capture
      // is only worth pinning once every one of them has run.
      expect(
        container.querySelectorAll(".meridian-transcript-row-layout").length,
        "no transcript row reached the document, so this capture would pin an empty feed",
      ).toBeGreaterThan(0);

      await captureSettled(frame, `concurrent-streaming-frame-${scheme}`);
    });
  }
});

describe("screenshot — the transcript's empty state", () => {
  it("renders a session that has a roster and no log", async () => {
    // One scheme rather than two, on `frame.test.tsx`'s reasoning for the palette:
    // both palettes are already pinned by the pair above, and what this capture
    // exists for is the copy and the shape of the absence, neither of which the
    // scheme decides.
    await emulateSystemScheme("light");
    const { transcriptBody } = await openTranscriptSession(
      EMPTY_SESSION_SCENARIO_ID,
      EMPTY_SESSION_SCENARIO.sessionId,
    );

    // The same walk the pair above takes, over a script that plays nothing. What it
    // is here for is the OTHER thing a walk does: the window's own first read is
    // armed on this frozen clock, and an unwalked mount photographs twelve loading
    // shells — a session whose emptiness the console has not been told yet, which is
    // a different picture and a different claim from the one this capture is named
    // for.
    const deliveredBeatCount = await walkScenarioToFrozenTick(
      EMPTY_SESSION_SCENARIO.beats.at(-1)?.atMs ?? 0,
    );
    expect(
      deliveredBeatCount,
      "a beat reached this window, so its empty state is the tail end of a session that " +
        "was still arriving rather than one with nothing in it",
    ).toBe(0);

    // The negative control for the pair above, and the positive one for this
    // capture: the empty state is reachable only because this scenario's script is
    // empty, so a row here would mean the fixture picker had handed over the wrong
    // session and the "empty state" capture was a picture of a loaded one.
    //
    // Asked of the CAPTURED element rather than of the whole mount, which is what the
    // scoping changed about them: a sentence read off the window is a sentence that
    // may be anywhere in it, and the claim this capture makes is that it is in the
    // box being photographed.
    expect(transcriptBody.querySelectorAll(".meridian-transcript-row-layout")).toHaveLength(0);
    expect(transcriptBody.textContent).toContain("Nothing has happened in this session yet.");

    await captureSettled(transcriptBody, "empty-session-light");
  });
});

describe("the transcript mount wait", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // The negative control for the deadline above. Every capture in this file is
  // taken through a wait that reports an absent body, and a wait that cannot
  // report one is a wait that reports every body as present — so this drives
  // the real `awaitSessionRouteMounted` against a route that mounts none and
  // asserts the refusal, which is the one path the three captures never take.
  //
  // The clock is faked rather than waited out, and only `Date` is faked: the wait
  // reads the clock and settles turns on real macrotasks, so faking the timers as
  // well would suspend the very turns the loop is counting on and the refusal would
  // never be reached. The system time is pushed past the deadline after the loop
  // has yielded on its first turn, which is what makes this run in a millisecond
  // rather than in the five seconds the deadline names — and what proves it is the
  // DEADLINE that refuses, since no number of turns passed in between.
  it("refuses a route that mounts no transcript body, on the deadline rather than on a turn count", async () => {
    document.location.hash = formatRoute({ kind: "sessions" });
    const { container } = await renderSettled(
      <AppProviders composition={createFixtureComposition(TRANSCRIPT_STATES_SCENARIO_ID)} />,
    );
    expect(
      container.querySelector(SESSION_ROUTE_BODY_SELECTOR),
      "the session directory mounted a transcript body, so this control is asserting the refusal of a " +
        "route that in fact reaches the transcript body and would pass whatever the wait did",
    ).toBeNull();

    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAtMs = Date.now();
    const pending = awaitSessionRouteMounted(container);
    vi.setSystemTime(startedAtMs + SESSION_ROUTE_MOUNT_DEADLINE_MS + 1);

    await expect(pending).rejects.toThrow(
      `the session route mounted no body in ${String(SESSION_ROUTE_MOUNT_DEADLINE_MS)} ms`,
    );
  });
});
