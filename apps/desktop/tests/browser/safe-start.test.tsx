// A safe start, the load main marks after repeated renderer losses, against a real IndexedDB: the
// app opens one window on the sessions list, reads no kept window layout and leaves it as it was,
// and says so in one line; `Restore windows` reopens every kept window. The negative control is an
// ordinary load over the same kept layout, which opens the kept windows and shows no line.

import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AppProviders } from "#renderer/app/AppProviders.js";
import { createFixtureComposition } from "#renderer/app/fixture/composition.js";
import { FIXTURE_WINDOW_ID } from "#renderer/services/platform/platform-bridge.fixture.js";
import { UI_STATE_DATABASE_NAME } from "#renderer/store/persistence/indexeddb-persistence-adapter.js";
import { UiStateStore } from "#renderer/store/persistence/ui-state-store.js";
import {
  keepWindowIds,
  readKeptWindowIds,
} from "#renderer/store/window-layout/kept-window-layout.js";
import { SAFE_START_ATTRIBUTE } from "#shared/window/safe-start.js";
import { FIRST_RUN_SCENARIO_ID } from "../../fixtures/scenarios/first-run.js";
import { FrameWindows } from "../helpers/frame-windows.js";
import { crossMacrotaskBoundary } from "../helpers/macrotask-boundary.js";

const SAFE_START_LINE = "The app restarted after repeated problems. Your windows weren't restored.";

/** The windows the last run kept, beside the one the fixture launch names as used last. */
const KEPT_WINDOW_IDS = ["window/kept-first", "window/kept-second"];

const frames = new FrameWindows();

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

/** Mount the app, let the kept layout's read land, and answer the window used last. */
async function mountApp(): Promise<Window> {
  await act(async () => {
    render(
      <AppProviders
        composition={createFixtureComposition(FIRST_RUN_SCENARIO_ID)}
        openWindow={frames.open}
      />,
    );
    await crossMacrotaskBoundary();
  });
  await expect.poll(() => frames.openedIds().length).toBeGreaterThan(0);
  return frames.windowNamed(FIXTURE_WINDOW_ID);
}

beforeEach(async () => {
  document.location.hash = "";
  await deleteUiStateDatabase();
  await withUiStateStore(async (store) => keepWindowIds(store, KEPT_WINDOW_IDS));
});

afterEach(async () => {
  cleanup();
  frames.removeAll();
  document.documentElement.removeAttribute(SAFE_START_ATTRIBUTE);
  await deleteUiStateDatabase();
});

describe("a safe start", () => {
  it("opens one window on the sessions list, keeps the layout, and restores it on request", async () => {
    document.documentElement.setAttribute(SAFE_START_ATTRIBUTE, "");

    const usedLast = await mountApp();
    const shown = within(usedLast.document.body);
    await expect.poll(() => shown.queryByText(SAFE_START_LINE)).not.toBeNull();

    expect(frames.openedIds()).toEqual([FIXTURE_WINDOW_ID]);
    expect(usedLast.location.hash).toBe("#/sessions");
    // Settled first, so a write the load made would have landed.
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    expect(await withUiStateStore(readKeptWindowIds)).toEqual(KEPT_WINDOW_IDS);

    await act(async () => {
      fireEvent.click(shown.getByRole("button", { name: "Restore windows" }));
      await crossMacrotaskBoundary();
    });

    await expect.poll(() => frames.openedIds()).toEqual([FIXTURE_WINDOW_ID, ...KEPT_WINDOW_IDS]);
    await expect.poll(() => shown.queryByText(SAFE_START_LINE)).toBeNull();
    // Restored, the kept layout follows the open windows again.
    await expect
      .poll(async () => withUiStateStore(readKeptWindowIds))
      .toEqual([FIXTURE_WINDOW_ID, ...KEPT_WINDOW_IDS]);
  });

  it("negative control: an ordinary load opens the kept windows and shows no line", async () => {
    const usedLast = await mountApp();

    await expect.poll(() => frames.openedIds()).toEqual([FIXTURE_WINDOW_ID, ...KEPT_WINDOW_IDS]);
    expect(within(usedLast.document.body).queryByText(SAFE_START_LINE)).toBeNull();
  });
});
