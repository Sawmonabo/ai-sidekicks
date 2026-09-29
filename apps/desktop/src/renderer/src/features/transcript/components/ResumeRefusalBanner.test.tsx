// The refused position reaches a screen, driven through the screen that mounts it.
//
// WHAT THIS SUITE PROVES, IN BOTH DIRECTIONS. The resume decision reaches the screen
// (a decision computed on every read but rendered by nothing is the failure one way),
// and only its refused arm draws the banner (a banner on every ordinary read is the
// failure the other way). So this suite drives the REGISTERED session screen, and the
// arm it asserts on is a refusal the daemon actually raised about a position this
// console actually sent.
//
// EVERYTHING BELOW THE SCREEN IS REAL: a real `SessionStoreRegistry` opening a real
// entry, whose real scheduler performs real reads, the second of which carries the
// position the first acknowledged. The only stand-in is the session screen BODY, which is
// the composition root's parameter and another feature's component entirely.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { FixtureBridgeProvider } from "@test/helpers/app-frame-fixtures.js";
import { EMPTY_SESSION_SCENARIO } from "../../../../../../fixtures/scenarios/empty-session.js";
import { ManualClock } from "@renderer/lib/clock.js";
import { settle as settleReactWork } from "@test/helpers/settle.js";
import { PaneRegistry } from "@renderer/registries/panes/pane-registry.js";
import { ScreenRegistry } from "@renderer/registries/screens/screen-registry.js";
import type { ScreenContext } from "@renderer/registries/screens/screen-context.js";
import { SessionStoreRegistry } from "@renderer/store/session/session-store-registry.js";
import { type SessionSnapshot } from "@renderer/store/session/session-state.js";
import { registerTranscriptScreens } from "../contributions/screens.js";

const SESSION_ID = "session-resume-degraded";

/** The code the banner renders verbatim. This module's own, never the daemon's. */
const REFUSAL_CODE = "resume-cursor-unresolvable";

/** The position the first read acknowledges, and the second read submits. */
const ACKNOWLEDGED = "7_1723291480000000000";

afterEach(() => {
  cleanup();
});

/** A snapshot at `cursor`, acknowledged where one is supplied. */
function snapshotAt(cursor: number, acknowledged?: string): SessionSnapshot {
  return {
    cursor,
    entities: [],
    timelineCursors: {
      latest: "9_1723291500000000000",
      ...(acknowledged === undefined ? {} : { acknowledged }),
    },
  };
}

/**
 * Render the registered `session` screen over a registry whose reads follow a
 * script, and refresh it `refreshes` times.
 *
 * The screen is resolved from a registry composed HERE rather than the process-wide
 * one, because a case that registered into the singleton would
 * be asserting over a board production also fills.
 */
async function renderSessionScreen(input: {
  readonly reads: readonly (SessionSnapshot | { readonly rejectWith: unknown })[];
  readonly refreshes: number;
}): Promise<void> {
  // A manual clock, because the scheduler debounces every request against one: the
  // reads have to have COMPLETED before the render, or every arm renders the interval
  // before a decision exists and the negative controls pass on nothing.
  const clock = new ManualClock(0);
  let readIndex = 0;
  const sessionStoreRegistry = new SessionStoreRegistry({
    clock,
    refreshDebounceMs: 20,
    read: () => {
      const step = input.reads[Math.min(readIndex, input.reads.length - 1)];
      readIndex += 1;
      if (step !== undefined && "rejectWith" in step) {
        return Promise.reject(step.rejectWith);
      }
      return Promise.resolve(step);
    },
  });
  const sessionStore = sessionStoreRegistry.open(SESSION_ID);
  const screens = new ScreenRegistry();
  registerTranscriptScreens(screens, {
    sessionScreen: () => <div data-testid="session-screen-body" />,
  });
  const descriptor = screens.descriptorFor("session");
  if (descriptor === undefined) {
    throw new Error("the transcript feature registered no session screen");
  }

  for (let turn = 0; turn < input.refreshes; turn += 1) {
    sessionStoreRegistry.requestRefresh(SESSION_ID, "window-focus");
    clock.advance(21);
    await settleReactWork();
  }

  // Under the provider, because this mounts the WHOLE session screen and the
  // views composed into it read the bridge the way every view in the console does. The
  // scenario is the quiet one: this suite's subject is the resume decision, which the
  // registry above settles, so a scenario with a script would be beats nothing here
  // reads. The gap fill mounted beside the resume notice renders nothing for a window
  // that is missing nothing, which every case here is.
  render(
    <FixtureBridgeProvider fixture={createFixtureBridge({ scenario: EMPTY_SESSION_SCENARIO })}>
      {descriptor.render({
        route: { kind: "session", sessionId: SESSION_ID },
        bridge: { source: "fixture" },
        frameStore: {},
        sessionStore,
        sessionStoreRegistry,
        uiStateStore: {},
        draftStore: {},
        paneRegistry: new PaneRegistry(),
      } as unknown as ScreenContext)}
    </FixtureBridgeProvider>,
  );
  await settleReactWork();
}

/** The read that refuses the position the previous read acknowledged. */
const REFUSES_THE_POSITION = {
  rejectWith: {
    code: "event.cursor_unresolvable",
    message: "the submitted cursor could not be decoded",
  },
};

describe("the session screen renders the refused resume position", () => {
  it("says the remembered position could not be resumed", async () => {
    await renderSessionScreen({
      reads: [snapshotAt(7, ACKNOWLEDGED), REFUSES_THE_POSITION, snapshotAt(0)],
      refreshes: 2,
    });

    expect(screen.getByText(REFUSAL_CODE)).toBeTruthy();
    expect(screen.getByText(/re-read from the beginning/u)).toBeTruthy();
  });

  it("reaches the screen even though the recovering read establishes nothing", async () => {
    // The reason the decision carries its own notification. The recovery answers at
    // the beginning of the window, which `admitsSnapshotAt` refuses for arriving
    // behind the store's cursor — so no store transition happens and a screen
    // subscribed to the projection's revision alone would render nothing at all.
    await renderSessionScreen({
      reads: [snapshotAt(7, ACKNOWLEDGED), REFUSES_THE_POSITION, snapshotAt(0)],
      refreshes: 2,
    });

    expect(screen.getByText(REFUSAL_CODE)).toBeTruthy();
  });

  it("negative control: an honored position renders no notice at all", async () => {
    // Without this, a screen that rendered the sentence unconditionally would pass
    // both cases above — and would tell every session its position was lost.
    await renderSessionScreen({
      reads: [snapshotAt(7, ACKNOWLEDGED), snapshotAt(9, "9_1723291500000000000")],
      refreshes: 2,
    });

    expect(screen.queryByText(REFUSAL_CODE)).toBeNull();
  });

  it("negative control: a first read that acknowledges nothing renders no notice", async () => {
    // The arm the retired rule refused on: nothing acknowledged is the ordinary first
    // read, not a failure, and it is what every scripted scenario answers with. A
    // screen that treated it as a refusal put a band above every session screen.
    await renderSessionScreen({ reads: [snapshotAt(0)], refreshes: 1 });

    expect(screen.queryByText(REFUSAL_CODE)).toBeNull();
  });

  it("negative control: the session screen body mounts on both arms", async () => {
    // The notice renders ABOVE the room and never in place of it. Without this, a
    // screen that replaced the session screen with the refusal would satisfy the first
    // case while reporting an outage the daemon is not having.
    await renderSessionScreen({
      reads: [snapshotAt(7, ACKNOWLEDGED), REFUSES_THE_POSITION, snapshotAt(0)],
      refreshes: 2,
    });

    expect(screen.getByTestId("session-screen-body")).toBeTruthy();
  });

  it("clears once a later read settles a position of its own", async () => {
    // Not a permanent band. The decision is the newest completed read's, so the next
    // ordinary refresh replaces the refusal and this renders nothing.
    await renderSessionScreen({
      reads: [
        snapshotAt(7, ACKNOWLEDGED),
        REFUSES_THE_POSITION,
        snapshotAt(0),
        snapshotAt(11, "11_1723291600000000000"),
      ],
      refreshes: 3,
    });

    expect(screen.queryByText(REFUSAL_CODE)).toBeNull();
  });
});
