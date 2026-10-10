// Opening the app, against main's report of the background service as a test plays it: the window
// draws one cover saying what main is doing until the service first answers, over the console's
// inert frame; every screen draws its own frame there with nothing that reads the service, and a
// session's frame is drawn at its saved arrangement with no pane body and the composer's room held
// empty; each stays where it is when the cover fades; a repair's count moves on the cover as each
// new count arrives, drawn as wire figures; at the answer the cover fades over the console and
// never comes back, whatever the link does after; and a service that cannot be reached at boot
// draws the not-answering card, whose `Retry` ends its line and asks main to start the service.
// The negative control for the card is the same report after the first answer, which draws none.

import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFixtureComposition } from "#renderer/app/fixture/composition.js";
import { PANE_LAYOUT_RECORD_KEY } from "#renderer/features/sessions/pane-layout/persistence.js";
import {
  PANE_LAYOUT_RESTORED_PANE_CAP,
  PaneLayoutStore,
} from "#renderer/features/sessions/pane-layout/store.js";
import { formatRoute, type AppRoute } from "#renderer/routing/routes.js";
import type { BridgeComposition } from "#renderer/services/platform/bridge-context.js";
import { UI_STATE_DATABASE_NAME } from "#renderer/store/persistence/indexeddb-adapter.js";
import { UiStateStore } from "#renderer/store/persistence/ui-state-store.js";
import { UNREPORTED_MAIN_PROCESS_STATE } from "#renderer/store/window/main-process-state.js";
import {
  DAEMON_STATUS_TOPIC,
  NOT_ANSWERING_MESSAGE,
  type DaemonConnection,
  type MainProcessState,
} from "#shared/daemon/status-topic.js";
import type { DaemonWire } from "#shared/preload-api.js";
import { FIRST_RUN_SCENARIO_ID } from "#fixtures/scenarios/first-run.js";
import {
  SESSION_ID,
  TRANSCRIPT_STATES_SCENARIO_ID,
} from "#fixtures/scenarios/transcript-states.js";
import { renderAppSettled } from "../helpers/app/harness.js";
import { crossMacrotaskBoundary } from "../helpers/macrotask-boundary.js";

const REPAIRING_LINE = "Repairing saved sessions after an unexpected shutdown";

/** Main as a case plays it: the service's state it reports, and the starts it was asked for. */
interface MainStandIn {
  readonly composition: BridgeComposition;
  /** Report `connection` to every window, as main's supervisor does. */
  readonly report: (connection: DaemonConnection) => Promise<void>;
  readonly startRequests: () => number;
}

/** The scenario's composition, its status topic and start answered by the case, not by it. */
function standInForMain(scenarioId: string = FIRST_RUN_SCENARIO_ID): MainStandIn {
  const fixture = createFixtureComposition(scenarioId);
  const statusHandlers = new Set<(state: MainProcessState) => void>();
  let startRequests = 0;
  return {
    composition: {
      ...fixture,
      createBridge: () => {
        const composed = fixture.createBridge();
        const scenarioDaemon = composed.bridge.daemon;
        const daemon: DaemonWire = {
          ...scenarioDaemon,
          subscribe: (event, params, handler, onEnded) => {
            if (event !== DAEMON_STATUS_TOPIC) {
              return scenarioDaemon.subscribe(event, params, handler, onEnded);
            }
            const statusHandler = handler as (state: MainProcessState) => void;
            statusHandlers.add(statusHandler);
            return () => {
              statusHandlers.delete(statusHandler);
            };
          },
          requestStart: async () => {
            startRequests += 1;
          },
        };
        return { ...composed, bridge: { ...composed.bridge, daemon } };
      },
    },
    report: async (connection) => {
      await act(async () => {
        for (const handler of statusHandlers) {
          handler({ ...UNREPORTED_MAIN_PROCESS_STATE, connection });
        }
        await crossMacrotaskBoundary();
      });
    },
    startRequests: () => startRequests,
  };
}

/** The window's boot cover, or `null` once it is gone. */
function bootCoverOf(appWindow: Window): Element | null {
  return appWindow.document.querySelector(".meridian-boot-cover");
}

/** The line the cover draws beside its working indicator, or `null` where it draws none. */
function coverLineOf(appWindow: Window): string | null {
  return appWindow.document.querySelector(".meridian-boot-cover__line")?.textContent ?? null;
}

/** The figures the cover's line draws as the service's own, in order. */
function coverLineWireFiguresOf(appWindow: Window): readonly string[] {
  return [
    ...appWindow.document.querySelectorAll(".meridian-boot-cover__line .meridian-figure--wire"),
  ].map((figure) => figure.textContent);
}

/** The not-answering card's line, or `null` while no card is drawn. */
function cardLineOf(appWindow: Window): string | null {
  return appWindow.document.querySelector(".meridian-boot-cover__card-line")?.textContent ?? null;
}

/** The window's console frame, or `null` where none is drawn. */
function consoleFrameOf(appWindow: Window): Element | null {
  return appWindow.document.querySelector(".meridian-frame");
}

/** The region the routed screen is drawn into. */
function screenRegionOf(appWindow: Window): Element {
  const region = appWindow.document.querySelector(".meridian-frame__screen");
  if (region === null) {
    throw new Error("the window drew no screen region");
  }
  return region;
}

/** Where `element` sits in the window, in CSS px. */
function boxOf(element: Element): { left: number; width: number; top: number; height: number } {
  const box = element.getBoundingClientRect();
  return { left: box.left, width: box.width, top: box.top, height: box.height };
}

/** The element `selector` names in the window, which must be drawn. */
function drawnElementOf(appWindow: Window, selector: string): Element {
  const element = appWindow.document.querySelector(selector);
  if (element === null) {
    throw new Error(`the window drew no ${selector}`);
  }
  return element;
}

/**
 * A screen's frame as a case reads it: the element that must stand at the same place under the
 * cover and after the answer, the region that reads the service, and what that region holds.
 */
interface ScreenFrameCase {
  readonly name: string;
  readonly route: AppRoute;
  /** The screen's own frame, drawn under the cover and left where it stands at the answer. */
  readonly frameSelector: string;
  /** What the screen draws only from the service, absent under the cover; none reads nothing. */
  readonly serviceRegionSelector?: string;
}

const SCREEN_FRAME_CASES: readonly ScreenFrameCase[] = [
  {
    name: "the Sessions destination",
    route: { kind: "sessions" },
    // The destination reads nothing yet, so nothing of it waits for the service.
    frameSelector: ".meridian-sessions__title",
  },
  {
    name: "a Settings page",
    route: { kind: "settings", page: "runtime" },
    frameSelector: ".meridian-settings__page-heading",
    serviceRegionSelector: ".meridian-settings__page > div > *",
  },
  {
    name: "the Workflows runs tab",
    route: { kind: "workflows", tab: "runs" },
    frameSelector: ".meridian-workflows-tabs",
    serviceRegionSelector: ".meridian-workflows-strip, .meridian-workflows-tabs__count",
  },
];

/** Each pane the window draws, in order. */
function panesOf(appWindow: Window): readonly HTMLElement[] {
  return [...appWindow.document.querySelectorAll<HTMLElement>(".meridian-pane")];
}

/** Each pane's head as a person reads it: its trail's words and its controls' names. */
function paneHeadsOf(appWindow: Window): readonly string[] {
  return panesOf(appWindow).map((pane) => {
    const head = pane.querySelector(".meridian-pane__head");
    const controls = [...(head?.querySelectorAll("button") ?? [])].map((button) =>
      button.getAttribute("aria-label"),
    );
    return `${head?.textContent ?? ""} | ${controls.join(", ")}`;
  });
}

/** Where each pane sits in the window, in CSS px. */
function paneBoxesOf(
  appWindow: Window,
): readonly { left: number; width: number; top: number; height: number }[] {
  return panesOf(appWindow).map(boxOf);
}

/** Save, for `sessionId`, the transcript at half the width beside a terminal and an inspector. */
async function saveTranscriptBesideTwoPanes(sessionId: string): Promise<void> {
  const layout = new PaneLayoutStore({ restoredPaneCap: PANE_LAYOUT_RESTORED_PANE_CAP });
  const transcriptPaneId = layout.open({ kind: "transcript" });
  const terminalPaneId = layout.open({ kind: "terminal" });
  const inspectorPaneId = layout.open({
    kind: "inspector",
    entity: { kind: "worktree", id: "worktree-01" },
  });
  layout.applyLayout({ [transcriptPaneId]: 50, [terminalPaneId]: 25, [inspectorPaneId]: 25 }, 1);
  const store = UiStateStore.opening();
  try {
    const result = await store.write(
      sessionId,
      PANE_LAYOUT_RECORD_KEY,
      "layout",
      layout.toSnapshot(),
    );
    expect(result.outcome).toBe("written");
  } finally {
    await store.close();
  }
}

async function deleteUiStateDatabase(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const deletion = indexedDB.deleteDatabase(UI_STATE_DATABASE_NAME);
    deletion.onsuccess = () => {
      resolve();
    };
    deletion.onerror = () => {
      reject(deletion.error ?? new Error("the UI-state database was not deleted"));
    };
  });
}

/** Wait until the cover has faded and gone; `waitFor` lets React flush the `transitionend`. */
async function untilCoverGone(appWindow: Window): Promise<void> {
  await waitFor(() => {
    expect(bootCoverOf(appWindow)).toBeNull();
  });
}

beforeEach(async () => {
  document.location.hash = "";
  await deleteUiStateDatabase();
});

afterEach(() => {
  cleanup();
});

describe("browser — opening the app", () => {
  it("covers the window's inert frame until the service first answers", async () => {
    const main = standInForMain();
    const appWindow = await renderAppSettled(FIRST_RUN_SCENARIO_ID, undefined, main.composition);

    await main.report({ kind: "connecting" });
    expect(coverLineOf(appWindow)).toBe("Connecting to the background service…");
    // A link lost before the first answer is still being connected to, not reconnected.
    await main.report({ kind: "transient_disconnect", attempt: 1, attemptLimit: 5 });
    expect(coverLineOf(appWindow)).toBe("Connecting to the background service…");
    await main.report({ kind: "starting" });
    expect(coverLineOf(appWindow)).toBe("Starting the background service…");
    expect(appWindow.document.querySelector(".meridian-rail")).not.toBeNull();
    expect(appWindow.document.querySelector(".meridian-frame__background[inert]")).not.toBeNull();

    await main.report({ kind: "connected" });
    expect(appWindow.document.querySelector(".meridian-frame__background[inert]")).toBeNull();
    await untilCoverGone(appWindow);
  });

  for (const frameCase of SCREEN_FRAME_CASES) {
    it(`draws ${frameCase.name}'s own frame under the cover and keeps it`, async () => {
      document.location.hash = formatRoute(frameCase.route);
      const main = standInForMain();
      const appWindow = await renderAppSettled(FIRST_RUN_SCENARIO_ID, undefined, main.composition);
      await main.report({ kind: "starting" });

      await waitFor(() => {
        expect(screenRegionOf(appWindow).querySelector(frameCase.frameSelector)).not.toBeNull();
      });
      expect(bootCoverOf(appWindow)).not.toBeNull();
      const frame = drawnElementOf(appWindow, frameCase.frameSelector);
      // Measured once the fonts its first layout asked for have loaded: a font that loads late
      // moves text with or without the cover, and the frame's `ch` widths follow the font.
      boxOf(frame);
      await appWindow.document.fonts.ready;
      const frameBoxUnderCover = boxOf(frame);
      // Nothing the service answers is drawn, and nothing stands in for it.
      if (frameCase.serviceRegionSelector !== undefined) {
        expect(appWindow.document.querySelector(frameCase.serviceRegionSelector)).toBeNull();
      }

      await main.report({ kind: "connected" });
      await untilCoverGone(appWindow);
      const { serviceRegionSelector } = frameCase;
      if (serviceRegionSelector !== undefined) {
        await waitFor(() => {
          expect(appWindow.document.querySelector(serviceRegionSelector)).not.toBeNull();
        });
      }
      // The same frame, where it stood under the cover.
      expect(drawnElementOf(appWindow, frameCase.frameSelector).textContent).toBe(
        frame.textContent,
      );
      expect(boxOf(drawnElementOf(appWindow, frameCase.frameSelector))).toStrictEqual(
        frameBoxUnderCover,
      );
    });
  }

  it("draws a session's saved arrangement under the cover and keeps it", async () => {
    await saveTranscriptBesideTwoPanes(SESSION_ID);
    document.location.hash = formatRoute({ kind: "session", sessionId: SESSION_ID });
    const main = standInForMain(TRANSCRIPT_STATES_SCENARIO_ID);
    const appWindow = await renderAppSettled(
      TRANSCRIPT_STATES_SCENARIO_ID,
      undefined,
      main.composition,
    );
    await main.report({ kind: "starting" });

    await waitFor(() => {
      expect(panesOf(appWindow).map((pane) => pane.className)).toStrictEqual([
        expect.stringContaining("meridian-pane--transcript"),
        expect.stringContaining("meridian-pane--terminal"),
        expect.stringContaining("meridian-pane--inspector"),
      ]);
    });
    expect(bootCoverOf(appWindow)).not.toBeNull();
    expect(appWindow.document.querySelector(".meridian-rail")).not.toBeNull();
    // Each pane wears its frame and nothing the session's data draws: no row, and no composer but
    // its resting space, which draws nothing.
    for (const pane of panesOf(appWindow)) {
      const body = pane.querySelector(".meridian-pane__body");
      expect(body?.childElementCount).toBe(0);
      expect(body?.textContent).toBe("");
    }
    expect(appWindow.document.querySelector('textarea[aria-label="Message"]')).toBeNull();
    expect(
      appWindow.document.querySelector(".meridian-session-screen__composer:not([data-resting])"),
    ).toBeNull();
    const paneLayout = appWindow.document.querySelector(".meridian-pane-layout");
    const boxesUnderCover = paneBoxesOf(appWindow);
    const headsUnderCover = paneHeadsOf(appWindow);
    expect(headsUnderCover[2]).toContain("worktree-01");
    expect(boxesUnderCover[1]?.width).toBeLessThan(boxesUnderCover[0]?.width ?? 0);

    await main.report({ kind: "connected" });
    await waitFor(() => {
      expect(
        appWindow.document.querySelector(".meridian-pane--transcript .meridian-pane__body")
          ?.childElementCount,
      ).toBeGreaterThan(0);
      expect(appWindow.document.querySelector('textarea[aria-label="Message"]')).not.toBeNull();
    });
    // The same pane layout, each pane where it stood under the cover and as tall, the composer
    // having arrived in the room held for it.
    expect(appWindow.document.querySelector(".meridian-pane-layout")).toBe(paneLayout);
    expect(paneBoxesOf(appWindow)).toStrictEqual(boxesUnderCover);
    // Each head wears the same trail and controls it wore under the cover.
    expect(paneHeadsOf(appWindow)).toStrictEqual(headsUnderCover);
  });

  it("moves the repair's count on the cover as each new count arrives", async () => {
    const main = standInForMain();
    const appWindow = await renderAppSettled(FIRST_RUN_SCENARIO_ID, undefined, main.composition);

    await main.report({ kind: "repairing", progress: { done: 120, total: 400 } });
    expect(coverLineOf(appWindow)).toBe(`${REPAIRING_LINE} · 120 of 400`);
    await main.report({ kind: "repairing", progress: { done: 121, total: 400 } });
    expect(coverLineOf(appWindow)).toBe(`${REPAIRING_LINE} · 121 of 400`);
    // The counts are the service's own figures, drawn as wire figures.
    expect(coverLineWireFiguresOf(appWindow)).toStrictEqual(["121", "400"]);
    await main.report({ kind: "repairing", progress: undefined });
    expect(coverLineOf(appWindow)).toBe(`${REPAIRING_LINE}…`);
  });

  it("never draws the cover or the card again once the service has answered", async () => {
    const main = standInForMain();
    const appWindow = await renderAppSettled(FIRST_RUN_SCENARIO_ID, undefined, main.composition);
    await main.report({ kind: "connecting" });
    await main.report({ kind: "connected" });
    await untilCoverGone(appWindow);

    // The link is lost, brought back, given up on, and started again on the person's `Retry`.
    await main.report({ kind: "transient_disconnect", attempt: 1, attemptLimit: 5 });
    await main.report({ kind: "degraded", attemptLimit: 5, lastError: "connect ECONNREFUSED" });
    await main.report({ kind: "connecting" });
    await main.report({ kind: "starting" });

    expect(bootCoverOf(appWindow)).toBeNull();
    expect(cardLineOf(appWindow)).toBeNull();
    expect(consoleFrameOf(appWindow)).not.toBeNull();
  });

  it("draws the not-answering card at boot, its Retry asking for a start", async () => {
    const main = standInForMain();
    const appWindow = await renderAppSettled(FIRST_RUN_SCENARIO_ID, undefined, main.composition);
    await main.report({ kind: "starting" });

    await main.report({ kind: "degraded", attemptLimit: 5, lastError: "spawn node ENOENT" });
    // `Retry` ends the card's own line.
    expect(cardLineOf(appWindow)).toBe(`${NOT_ANSWERING_MESSAGE} Retry`);
    expect(coverLineOf(appWindow)).toBeNull();
    // The card stands on the solid ground, which hides the frame under it.
    expect(bootCoverOf(appWindow)?.hasAttribute("data-not-answering")).toBe(true);

    await act(async () => {
      fireEvent.click(drawnElementOf(appWindow, ".meridian-boot-cover__card-line button"));
      await crossMacrotaskBoundary();
    });
    expect(main.startRequests()).toBe(1);

    // The start main begins puts the cover back in the card's place.
    await main.report({ kind: "starting" });
    expect(cardLineOf(appWindow)).toBeNull();
    expect(coverLineOf(appWindow)).toBe("Starting the background service…");
  });
});
