// The screenshot tier's ledger arm: the console's signature surface, pinned.
//
// `Spec-023 §Console Test Tiers` puts "the flagship frame at its frozen tick" on
// this tier, and the ledger is what makes that sentence worth anything — the frame
// beside it is chrome around an empty surface until a session is open in it. So
// this file captures the whole console window with the FLAGSHIP session loaded, in
// both schemes, and the ledger's own region for the one state no loaded session can
// reach.
//
// WHY THE FLAGSHIP PAIR IS THE WHOLE FRAME AND NOT THE LEDGER ALONE. The claim
// those two pin is a COMPOSITION: the rail, the cast bar, the deck, the chapters,
// and the attribution hues all have to be true at once and in the right
// relationship to each other. A shot cropped to the ledger's own box would still be
// green the day the rail overlapped it. Being whole frames is also what makes the
// sidebar's own hazard theirs: `workspace.test.tsx`'s header states it — a collapse
// is durable, so a restored arrangement moves a frame neither of these captures
// was taken with — which is why both take `requireSidebarExpanded` before they are
// photographed, out of the same module that file reads it from.
//
// AND WHY THE QUIET ARM IS THE LEDGER'S OWN REGION AND NOT THE FRAME. Its claim is
// the opposite one: the copy and the shape of an absence, which is a claim about a
// surface rather than about a composition. Captured whole, it pinned a frame with an
// empty ledger in it — which is exactly the frame `workspace.test.tsx` pins for its
// expanded sidebar, over this same scenario and this same route, and the two
// captures were byte-identical. So the quiet arm captures the element the session
// route mounts the ledger into, and the sidebar-arm hazard above is moot for it:
// there is no sidebar in the image to be in the wrong arm.
//
// WHY THE FLAGSHIP AND NOT THE THREE-LANE LEDGER. The tier's sentence names the
// FLAGSHIP frame, and this capture used to pin `ledger.ts` instead — a fine frame,
// and not the one the sentence is about. `flagship.ts` is the composition that
// carries every signature surface at one tick: four lanes streaming in four hues
// inside their own chapters, a cast of six with live verbs, an approval asked and
// granted mid-stream, a lane parked on a provider quota with the instant it resets
// at, a helper run threaded to the turn that spawned it, and the accountant's own
// committed figure on the bar. Pinning the smaller session left four of those out of
// the one image the frame is judged by.
//
// WHY A SECOND SCENARIO. `ledger-quiet.ts` is a session with a roster and an empty
// log, and it is here because rule 8's EMPTY is the one kind of nothing a scripted
// stream can never reach: every beat a script plays puts a row on screen. An empty
// state nobody can look at is an empty state nobody designed.
//
// WHY THE CAPTURE IS PRECEDED BY ASSERTIONS. A screenshot of an empty ledger is a
// perfectly stable image, and a capture aid that photographs one says nothing about
// whether the surface arrived. The three claims below the mount — the window is playing the
// scenario this file names, every beat reached it, and rows are on screen — are
// what stop this file pinning a picture of nothing. The quiet arm asserts the
// mirror image, for the same reason in the other direction: no beat reached it, and
// the sentence a session with nothing in it renders is on screen — which is the one
// claim a mount alone cannot make, since a window whose first read has not landed
// draws loading shells and says nothing at all.
//
// `settled-capture.ts` owns the mechanism this file rides: every capture is written
// into the gitignored `__screenshots__/` and compared against nothing, so this file
// gates on whether each surface can be captured at all.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  awaitSessionRouteMounted,
  emulateSystemScheme,
  renderSettled,
  resetDurableConsoleState,
  SESSION_ROUTE_BODY_SELECTOR,
  SESSION_ROUTE_MOUNT_DEADLINE_MS,
} from "../console-harness.js";
import { requireScenarioControl, walkScenarioToFrozenTick } from "../scenario-clock.js";
import { requireCapturedElement } from "./captured-element.js";
import { requireSidebarExpanded } from "./sidebar-arm.js";

import {
  ConsoleRoot,
  installMeridianTokens,
} from "../../../src/renderer/src/console/frame/index.js";
import { formatRoute } from "../../../src/renderer/src/console/routing/index.js";
import { CONSOLE_SCHEMES } from "../../../src/renderer/src/console/tokens/tokens.js";
import {
  LEDGER_QUIET_SCENARIO,
  LEDGER_QUIET_SCENARIO_ID,
} from "../../../src/renderer/src/console/bridge/scenario/ledger/ledger-quiet.js";
import {
  FLAGSHIP_SCENARIO,
  FLAGSHIP_SCENARIO_ID,
} from "../../../src/renderer/src/console/bridge/scenario/flagship/flagship.js";
import { LEDGER_SCENARIO_ID } from "../../../src/renderer/src/console/bridge/scenario/ledger/ledger.js";
import { captureSettled } from "./settled-capture.js";

/** What one opened fixture session hands back: the mount, and what to capture. */
interface LedgerMount {
  readonly container: HTMLElement;
  /** The whole console window — the composition the flagship pair pins. */
  readonly frame: Element;
  /**
   * The ledger's own region — what the quiet arm pins.
   *
   * The SAME element the mount wait above observes, rather than a second selector
   * for the same box: a capture element resolved independently of the wait could
   * name a surface the wait never guaranteed had arrived, and the two would drift.
   */
  readonly ledgerBody: Element;
}

/**
 * Open one fixture session at its own route and wait for it to finish arriving.
 *
 * The hash is assigned BEFORE the render rather than navigated to afterwards,
 * because `ConsoleRoot`'s frame store is born on the hash the window opened with —
 * a store that started on the default route publishes that default back over the
 * address on its first pass, which is a navigation this file would then be
 * photographing the tail end of.
 *
 * The wait is the harness's, and it names the LEDGER's scroll container rather than
 * the frame, which is the whole reason it is a wait at all: the frame is the
 * window's permanent shell and is on the page from the first commit, so a wait on it
 * hands back a console whose session route has not resolved yet. It observes the
 * MOUNT rather than the arrival of content, which is what the empty-state capture
 * needs it to observe.
 */
async function openLedgerSession(scenarioId: string, sessionId: string): Promise<LedgerMount> {
  document.location.hash = formatRoute({ kind: "workspace", sessionId });
  const { container } = await renderSettled(<ConsoleRoot scenarioId={scenarioId} />);
  expect(requireScenarioControl().scenarioId).toBe(scenarioId);

  await awaitSessionRouteMounted(container);

  return {
    container,
    frame: requireCapturedElement(container, ".meridian-frame"),
    ledgerBody: requireCapturedElement(container, SESSION_ROUTE_BODY_SELECTOR),
  };
}

beforeEach(async () => {
  // The database this window opens outlives the file that opened it: browser mode
  // gives every file in a session one origin, so an arrangement another file
  // persisted would be restored into these mounts and photographed here.
  await resetDurableConsoleState();
  document.location.hash = "";
  installMeridianTokens(document);
});

afterEach(async () => {
  // Leave the emulation off, so a later file's baseline is not captured under
  // whichever scheme this one finished in.
  await emulateSystemScheme("light");
});

describe("screenshot — the console under the flagship scenario", () => {
  for (const scheme of CONSOLE_SCHEMES) {
    it(`renders the ${scheme} scheme at the script's last beat`, async () => {
      await emulateSystemScheme(scheme);
      const { container, frame } = await openLedgerSession(
        FLAGSHIP_SCENARIO_ID,
        FLAGSHIP_SCENARIO.sessionId,
      );
      // This capture is a whole frame, so the sidebar is in it — the header says why
      // that makes the durable-collapse hazard this file's as much as the workspace
      // file's, even though neither of these captures is about the sidebar.
      requireSidebarExpanded(container);

      const deliveredBeatCount = await walkScenarioToFrozenTick(
        FLAGSHIP_SCENARIO.beats.at(-1)?.atMs ?? 0,
      );
      expect(
        deliveredBeatCount,
        "the whole script has to be in before the tick is frozen: a capture taken mid-script pins " +
          "a session that is still arriving, and the capture it writes moves with the loop above",
      ).toBe(FLAGSHIP_SCENARIO.beats.length);

      // Rows on screen, not merely events in a store. The projection, the window
      // fold, and the viewport's reconcile all sit between the two, and a capture
      // is only worth pinning once every one of them has run.
      expect(
        container.querySelectorAll(".meridian-ledger-row").length,
        "no ledger row reached the document, so this capture would pin an empty feed",
      ).toBeGreaterThan(0);

      await captureSettled(frame, `flagship-frame-${scheme}`);
    });
  }
});

describe("screenshot — the ledger's empty state", () => {
  it("renders a session that has a roster and no log", async () => {
    // One scheme rather than two, on `frame.test.tsx`'s reasoning for the palette:
    // both palettes are already pinned by the pair above, and what this capture
    // exists for is the copy and the shape of the absence, neither of which the
    // scheme decides.
    await emulateSystemScheme("light");
    const { ledgerBody } = await openLedgerSession(
      LEDGER_QUIET_SCENARIO_ID,
      LEDGER_QUIET_SCENARIO.sessionId,
    );

    // The same walk the pair above takes, over a script that plays nothing. What it
    // is here for is the OTHER thing a walk does: the window's own first read is
    // armed on this frozen clock, and an unwalked mount photographs twelve loading
    // shells — a session whose emptiness the console has not been told yet, which is
    // a different picture and a different claim from the one this capture is named
    // for.
    const deliveredBeatCount = await walkScenarioToFrozenTick(
      LEDGER_QUIET_SCENARIO.beats.at(-1)?.atMs ?? 0,
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
    expect(ledgerBody.querySelectorAll(".meridian-ledger-row")).toHaveLength(0);
    expect(ledgerBody.textContent).toContain("Nothing has happened in this session yet.");

    await captureSettled(ledgerBody, "ledger-quiet-light");
  });
});

describe("the ledger mount wait", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // The negative control for the deadline above. Every capture in this file is
  // taken through a wait that reports an absent body, and a wait that cannot
  // report one is a wait that reports every surface as present — so this drives
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
  it("refuses a route that mounts no ledger body, on the deadline rather than on a turn count", async () => {
    document.location.hash = formatRoute({ kind: "sessions" });
    const { container } = await renderSettled(<ConsoleRoot scenarioId={LEDGER_SCENARIO_ID} />);
    expect(
      container.querySelector(SESSION_ROUTE_BODY_SELECTOR),
      "the session directory mounted a ledger body, so this control is asserting the refusal of a " +
        "route that in fact reaches the surface and would pass whatever the wait did",
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
