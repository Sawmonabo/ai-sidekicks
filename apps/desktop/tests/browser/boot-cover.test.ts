// Opening the app, against main's report of the background service as a test plays it: the window
// draws one cover saying what main is doing, and no console under it, until the service first
// answers; a repair's count moves on the cover as each new count arrives, drawn as wire figures;
// at the answer the cover fades over the console and never comes back, whatever the link does
// after; and a service that cannot be reached at boot draws the not-answering card, whose `Retry`
// asks main to start it.
// The negative control for the card is the same report after the first answer, which draws none.

import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFixtureComposition } from "#renderer/app/fixture/composition.js";
import type { BridgeComposition } from "#renderer/services/platform/bridge-context.js";
import { UNREPORTED_MAIN_PROCESS_STATE } from "#renderer/store/window/main-process-state.js";
import {
  DAEMON_STATUS_TOPIC,
  NOT_ANSWERING_MESSAGE,
  type DaemonConnection,
  type MainProcessState,
} from "#shared/daemon/status-topic.js";
import type { DaemonWire } from "#shared/preload-api.js";
import { FIRST_RUN_SCENARIO_ID } from "#fixtures/scenarios/first-run.js";
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

/** The scenario's composition, its status topic and start answered by the case rather than by it. */
function standInForMain(): MainStandIn {
  const fixture = createFixtureComposition(FIRST_RUN_SCENARIO_ID);
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

/** The window's console frame, or `null` while none is drawn. */
function consoleFrameOf(appWindow: Window): Element | null {
  return appWindow.document.querySelector(".meridian-frame");
}

/** Wait until the cover has faded and gone; `waitFor` lets React flush the `transitionend` settle. */
async function untilCoverGone(appWindow: Window): Promise<void> {
  await waitFor(() => {
    expect(bootCoverOf(appWindow)).toBeNull();
  });
}

beforeEach(() => {
  document.location.hash = "";
});

afterEach(() => {
  cleanup();
});

describe("browser — opening the app", () => {
  it("covers the window, with no console under it, until the service first answers", async () => {
    const main = standInForMain();
    const appWindow = await renderAppSettled(FIRST_RUN_SCENARIO_ID, undefined, main.composition);

    await main.report({ kind: "connecting" });
    expect(coverLineOf(appWindow)).toBe("Connecting to the background service…");
    await main.report({ kind: "starting" });
    expect(coverLineOf(appWindow)).toBe("Starting the background service…");
    expect(consoleFrameOf(appWindow)).toBeNull();

    await main.report({ kind: "connected" });
    // The console is drawn under the cover at the answer, and the cover fades from over it.
    expect(consoleFrameOf(appWindow)).not.toBeNull();
    await untilCoverGone(appWindow);
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
    expect(consoleFrameOf(appWindow)).toBeNull();
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

  it("draws the not-answering card at boot in place of the console, and Retry asks for a start", async () => {
    const main = standInForMain();
    const appWindow = await renderAppSettled(FIRST_RUN_SCENARIO_ID, undefined, main.composition);
    const shown = within(appWindow.document.body);
    await main.report({ kind: "starting" });

    await main.report({ kind: "degraded", attemptLimit: 5, lastError: "spawn node ENOENT" });
    expect(cardLineOf(appWindow)).toBe(NOT_ANSWERING_MESSAGE);
    expect(coverLineOf(appWindow)).toBeNull();
    expect(consoleFrameOf(appWindow)).toBeNull();

    await act(async () => {
      fireEvent.click(shown.getByRole("button", { name: "Retry" }));
      await crossMacrotaskBoundary();
    });
    expect(main.startRequests()).toBe(1);

    // The start main begins puts the cover back in the card's place.
    await main.report({ kind: "starting" });
    expect(cardLineOf(appWindow)).toBeNull();
    expect(coverLineOf(appWindow)).toBe("Starting the background service…");
  });
});
