// A safe start, the load main marks after repeated renderer losses, against a real IndexedDB: the
// app opens one window on the sessions list, reads no kept window layout and leaves it as it was,
// and says so in one line; `Restore windows` reopens every kept window and tells main the safe
// start ended. The negative control is an ordinary load over the same kept layout, which opens the
// kept windows on their kept addresses, brings the window used last back to its own, and shows no
// line. Main's ask to reopen a window, once none is open, opens it.

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFixtureComposition } from "#renderer/app/fixture/composition.js";
import type { BridgeComposition } from "#renderer/services/platform/bridge-context.js";
import { FIXTURE_WINDOW_ID } from "#renderer/services/platform/bridge.fixture.js";
import { UI_STATE_DATABASE_NAME } from "#renderer/store/persistence/indexeddb-adapter.js";
import { UiStateStore } from "#renderer/store/persistence/ui-state-store.js";
import {
  keepWindows,
  readKeptWindows,
  type KeptWindow,
} from "#renderer/store/window/layout/kept.js";
import { SAFE_START_ATTRIBUTE } from "#shared/window/safe-start.js";
import { FIRST_RUN_SCENARIO_ID } from "#fixtures/scenarios/first-run.js";
import { renderAppSettled } from "../helpers/app/harness.js";
import { FrameWindows } from "../helpers/frame-windows.js";
import { crossMacrotaskBoundary } from "../helpers/macrotask-boundary.js";

const SAFE_START_LINE = "The app restarted after repeated problems. Your windows weren't restored.";

/** The window the fixture launch names as used last, as the last run kept it. */
const USED_LAST_KEPT: KeptWindow = { windowId: FIXTURE_WINDOW_ID, route: { kind: "workflows" } };

/** The other windows the last run kept, each on its own address. */
const OTHERS_KEPT: readonly KeptWindow[] = [
  { windowId: "window/kept-first", route: { kind: "settings", page: undefined } },
  { windowId: "window/kept-second", route: { kind: "sessions" } },
];

const KEPT_WINDOW_IDS = OTHERS_KEPT.map(({ windowId }) => windowId);

/** What main heard from the console document, and how a case asks it to reopen a window. */
interface MainStandIn {
  readonly composition: BridgeComposition;
  readonly safeStartEnds: () => number;
  readonly askToReopen: (windowId: string) => void;
}

/** The scenario's composition, its `window` members answered as main would answer them. */
function standInForMain(scenarioId: string): MainStandIn {
  const fixture = createFixtureComposition(scenarioId);
  let safeStartEnds = 0;
  const reopenHandlers = new Set<(windowId: string) => void>();
  return {
    composition: {
      ...fixture,
      createBridge: () => {
        const composed = fixture.createBridge();
        const windowMembers = {
          ...composed.bridge.window,
          endSafeStart: async (): Promise<void> => {
            safeStartEnds += 1;
          },
          subscribeToReopenRequest: (handler: (windowId: string) => void) => {
            reopenHandlers.add(handler);
            return () => {
              reopenHandlers.delete(handler);
            };
          },
        };
        return { ...composed, bridge: { ...composed.bridge, window: windowMembers } };
      },
    },
    safeStartEnds: () => safeStartEnds,
    askToReopen: (windowId) => {
      for (const handler of reopenHandlers) {
        handler(windowId);
      }
    },
  };
}

/**
 * Wait inside `act` until `assertion` holds, so the state the app's own reads settle while it
 * waits is flushed by React, not reported as an update outside `act`.
 */
async function untilInsideAct(assertion: () => PromiseLike<void>): Promise<void> {
  await act(async () => {
    await assertion();
  });
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

/** Run `read` against the UI-state database, closing the connection after. */
async function withUiStateStore<Answer>(
  read: (store: UiStateStore) => Promise<Answer>,
): Promise<Answer> {
  const store = UiStateStore.opening();
  try {
    return await read(store);
  } finally {
    await store.close();
  }
}

beforeEach(async () => {
  document.location.hash = "";
  await deleteUiStateDatabase();
  await withUiStateStore(async (store) => keepWindows(store, [USED_LAST_KEPT, ...OTHERS_KEPT]));
});

afterEach(async () => {
  cleanup();
  document.documentElement.removeAttribute(SAFE_START_ATTRIBUTE);
  await deleteUiStateDatabase();
});

describe("a safe start", () => {
  it("opens one window on the sessions list, keeps the layout, and restores it on request", async () => {
    document.documentElement.setAttribute(SAFE_START_ATTRIBUTE, "");
    const frames = new FrameWindows();
    const main = standInForMain(FIRST_RUN_SCENARIO_ID);

    const usedLast = await renderAppSettled(FIRST_RUN_SCENARIO_ID, frames, main.composition);
    const shown = within(usedLast.document.body);
    await untilInsideAct(() =>
      expect.poll(() => shown.queryByText(SAFE_START_LINE)).not.toBeNull(),
    );

    expect(frames.openedIds()).toEqual([FIXTURE_WINDOW_ID]);
    expect(usedLast.location.hash).toBe("#/sessions");
    // Settled first, so a write the load made would have landed.
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    expect(await withUiStateStore(readKeptWindows)).toEqual([USED_LAST_KEPT, ...OTHERS_KEPT]);
    expect(main.safeStartEnds()).toBe(0);

    await act(async () => {
      fireEvent.click(shown.getByRole("button", { name: "Restore windows" }));
      await crossMacrotaskBoundary();
    });

    await untilInsideAct(() =>
      expect.poll(() => frames.openedIds()).toEqual([FIXTURE_WINDOW_ID, ...KEPT_WINDOW_IDS]),
    );
    await untilInsideAct(() => expect.poll(() => shown.queryByText(SAFE_START_LINE)).toBeNull());
    // Main keeps each window's place again.
    expect(main.safeStartEnds()).toBe(1);
    expect(frames.windowNamed("window/kept-first").location.hash).toBe("#/settings");
    // Restored, the kept layout follows the open windows again, the used-last one where it is now.
    await untilInsideAct(() =>
      expect
        .poll(async () => withUiStateStore(readKeptWindows))
        .toEqual([{ windowId: FIXTURE_WINDOW_ID, route: { kind: "sessions" } }, ...OTHERS_KEPT]),
    );
  });

  it("negative control: an ordinary load opens the kept windows where they were", async () => {
    const frames = new FrameWindows();
    const usedLast = await renderAppSettled(FIRST_RUN_SCENARIO_ID, frames);

    await untilInsideAct(() =>
      expect.poll(() => frames.openedIds()).toEqual([FIXTURE_WINDOW_ID, ...KEPT_WINDOW_IDS]),
    );
    await untilInsideAct(() => expect.poll(() => usedLast.location.hash).toBe("#/workflows"));
    expect(frames.windowNamed("window/kept-first").location.hash).toBe("#/settings");
    expect(frames.windowNamed("window/kept-second").location.hash).toBe("#/sessions");
    expect(within(usedLast.document.body).queryByText(SAFE_START_LINE)).toBeNull();
    // The kept layout is written only after its read, so it still holds every address.
    await untilInsideAct(() =>
      expect
        .poll(async () => withUiStateStore(readKeptWindows))
        .toEqual([USED_LAST_KEPT, ...OTHERS_KEPT]),
    );
  });
});

describe("main's ask to reopen a window", () => {
  it("opens the window it names", async () => {
    const frames = new FrameWindows();
    const main = standInForMain(FIRST_RUN_SCENARIO_ID);
    await renderAppSettled(FIRST_RUN_SCENARIO_ID, frames, main.composition);
    await untilInsideAct(() =>
      expect.poll(() => frames.openedIds()).toEqual([FIXTURE_WINDOW_ID, ...KEPT_WINDOW_IDS]),
    );

    await act(async () => {
      main.askToReopen("window/closed-last");
      await crossMacrotaskBoundary();
    });

    expect(frames.openedIds()).toContain("window/closed-last");
  });
});
