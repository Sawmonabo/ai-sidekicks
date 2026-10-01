// The screenshot tier's transcript arm. `settled-capture.ts` owns the mechanism: every capture is
// written into the gitignored `__screenshots__/` and compared against nothing, so this file
// gates on whether each view can be captured at all.
//
// Two views. The whole window with the concurrent-streaming session, in both schemes: its claim
// is a composition (rail, session header, pane layout, run groups and agent hues at once), which
// a shot cropped to the transcript would miss. And the empty-session transcript region, whose
// claim is the copy and shape of an absence. Assertions precede each capture, because a
// screenshot of an empty transcript is a stable image: the loaded arm asserts every beat arrived
// and rows are on screen; the empty arm asserts no beat arrived and the empty sentence is on
// screen (a window whose first read has not landed draws skeleton rows).

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  awaitSessionRouteMounted,
  emulateSystemScheme,
  renderSettled,
  resetDurableAppState,
  SESSION_ROUTE_BODY_SELECTOR,
} from "../helpers/app-harness.js";
import { requireScenarioControl, walkScenarioToFrozenTick } from "./scenario-clock.js";
import { requireCapturedElement } from "./captured-element.js";

import { createFixtureComposition } from "@renderer/app/fixture-composition.js";
import { AppProviders } from "@renderer/app/AppProviders.js";
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
import { captureSettled } from "./settled-capture.js";

/** What one opened fixture session hands back: the mount, and what to capture. */
interface TranscriptMount {
  readonly container: HTMLElement;
  /** The whole window: the composition the concurrent-streaming pair captures. */
  readonly frame: Element;
  /**
   * The transcript's own region, what the quiet arm pins. It is the same element the mount wait
   * observes, so the capture cannot name an element the wait never guaranteed had arrived.
   */
  readonly transcriptBody: Element;
}

/**
 * Opens one fixture session at its own route and waits for it to finish arriving. The hash is
 * assigned before the render, because `AppProviders`'s frame store is born on the hash the window
 * opened with; a store that started on the default route would publish it back over the address
 * on its first pass. The wait names the transcript's scroll container, not the frame: the frame
 * is permanent chrome present from the first commit, so waiting on it returns a console whose
 * session route has not resolved. It observes the mount rather than the arrival of content,
 * which the empty-state capture needs.
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
  // The database outlives the file that opened it (browser mode gives every file in a session one
  // origin), so an arrangement another file persisted would be restored into these mounts.
  await resetDurableAppState();
  document.location.hash = "";
  installMeridianTokens(document);
});

afterEach(async () => {
  // Leave the emulation off so a later file's capture is not taken under this file's last scheme.
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

      // Rows on screen, not merely events in a store: the projection, the window fold and the
      // viewport's reconcile all sit between the two.
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
    // One scheme, as `app-frame.test.tsx` does for the palette: both are pinned by the pair
    // above, and this capture is for the copy and shape of the absence, which the scheme does
    // not decide.
    await emulateSystemScheme("light");
    const { transcriptBody } = await openTranscriptSession(
      EMPTY_SESSION_SCENARIO_ID,
      EMPTY_SESSION_SCENARIO.sessionId,
    );

    // The same walk over a script that plays nothing. The window's first read is armed on this
    // frozen clock, and an unwalked mount photographs skeleton rows: a session whose emptiness
    // the console has not been told yet.
    const deliveredBeatCount = await walkScenarioToFrozenTick(
      EMPTY_SESSION_SCENARIO.beats.at(-1)?.atMs ?? 0,
    );
    expect(
      deliveredBeatCount,
      "a beat reached this window, so its empty state is the tail end of a session that " +
        "was still arriving rather than one with nothing in it",
    ).toBe(0);

    // Negative control for the pair above and positive one for this capture: the empty state is
    // reachable only because this script is empty, so a row here would mean the fixture picker
    // handed over the wrong session. Asked of the captured element, not the whole mount, since
    // the claim is that the sentence is in the box being photographed.
    expect(transcriptBody.querySelectorAll(".meridian-transcript-row-layout")).toHaveLength(0);
    expect(transcriptBody.textContent).toContain("Nothing has happened in this session yet.");

    await captureSettled(transcriptBody, "empty-session-light");
  });
});
