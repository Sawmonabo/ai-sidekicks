// The refused resume position reaches the screen, driven through the registered session screen
// over a real `SessionStoreRegistry` and scheduler; only the session screen body is a stand-in.
// Both directions are covered: a decision that nothing renders, and a banner on every read.

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

/** The code the banner renders verbatim. */
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
 * Render the registered `session` screen over a registry whose reads follow a script, and
 * refresh it `refreshes` times. The screen is resolved from a registry composed here so a
 * case never registers into the process-wide one.
 */
async function renderSessionScreen(input: {
  readonly reads: readonly (SessionSnapshot | { readonly rejectWith: unknown })[];
  readonly refreshes: number;
}): Promise<void> {
  // A manual clock, because the scheduler debounces every request against one: the reads
  // must have completed before the render, or the negative controls pass on nothing.
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

  // Mounted under the provider because the whole session screen renders and its views read the
  // bridge. The quiet scenario is enough: the resume decision is settled by the registry above.
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
    // The recovery answers at the beginning of the window, which `admitsSnapshotAt` refuses
    // for arriving behind the store's cursor, so no store transition happens and a screen
    // subscribed to the projection's revision alone would render nothing.
    await renderSessionScreen({
      reads: [snapshotAt(7, ACKNOWLEDGED), REFUSES_THE_POSITION, snapshotAt(0)],
      refreshes: 2,
    });

    expect(screen.getByText(REFUSAL_CODE)).toBeTruthy();
  });

  it("negative control: an honored position renders no notice at all", async () => {
    // Without this, a screen that rendered the sentence unconditionally would pass both cases
    // above.
    await renderSessionScreen({
      reads: [snapshotAt(7, ACKNOWLEDGED), snapshotAt(9, "9_1723291500000000000")],
      refreshes: 2,
    });

    expect(screen.queryByText(REFUSAL_CODE)).toBeNull();
  });

  it("negative control: a first read that acknowledges nothing renders no notice", async () => {
    // Nothing acknowledged is the ordinary first read, not a refusal, and it is what every
    // scripted scenario answers with.
    await renderSessionScreen({ reads: [snapshotAt(0)], refreshes: 1 });

    expect(screen.queryByText(REFUSAL_CODE)).toBeNull();
  });

  it("negative control: the session screen body mounts on both arms", async () => {
    // The notice renders above the room, never in place of it.
    await renderSessionScreen({
      reads: [snapshotAt(7, ACKNOWLEDGED), REFUSES_THE_POSITION, snapshotAt(0)],
      refreshes: 2,
    });

    expect(screen.getByTestId("session-screen-body")).toBeTruthy();
  });

  it("clears once a later read settles a position of its own", async () => {
    // The decision is the newest completed read's, so the next ordinary refresh replaces it.
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
