// Main's registry of windows: the hidden window built at start with the console window used last;
// the windows a person sees counted, the last of them closing driving the platform's answer while a
// quit or a lost renderer closing them does not, and a person closing the load-failure page
// counting as the last; a quit closing the hidden window first and the rest once its document is
// gone; a Dock click, a menu-bar icon click and a second launch, before start, after it and
// during a quit, asking the kept console document to reopen the window used last; the renderer's
// process going away, answered on a later task by building the hidden window again, the third loss
// in a row a safe start the console document ends, and the count clearing after five quiet minutes;
// the window the console document's `window.open` gets (main's own options and kept place, never
// the page's, centered or cascaded when none is kept) and found again by the id its frame name
// carries; the pushes to the console document; and the window-place file across a close and a
// restart. `electron` is mocked; the place file is real, in a temporary folder.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { appFactsSwitches } from "#shared/app-facts.js";
import {
  DEFAULT_APPEARANCE_RECORD,
  MERIDIAN_GROUNDS,
  type AppearanceRecord,
} from "#shared/appearance.js";
import {
  APPEARANCE_VALUE_CHANNEL,
  REOPEN_WINDOW_CHANNEL,
  UNKEPT_SCHEME_CHANNEL,
} from "#shared/bridge-channels.js";
import { createElectronMock } from "#test/helpers/electron/mock/module.js";
import type { MockBaseWindow } from "#test/helpers/electron/mock/window.js";
import {
  asMockWindow,
  handedDocument,
  INDEX_URL,
  loggedMessages,
  testWindowFrame,
  windowOpenHandlerOf,
} from "#test/helpers/electron/mock/readers.js";

const electronMock = createElectronMock();

vi.mock("electron", () => electronMock.moduleExports);

/** The one display the mock reports. */
const PRIMARY_WORK_AREA = { x: 0, y: 25, width: 1440, height: 875 };

/** The widths the renderer hands for a pane's own window with no kept place. */
const HANDED_SIZES = { paneWidths: { terminal: 480 } };

/**
 * Where a window of session views with no kept place opens on it: the work area less one 30 px
 * cascade step on every side.
 */
const CENTERED_ON_PRIMARY = { x: 30, y: 55, width: 1380, height: 815 };

/** The app facts the hidden window is started with, so the preload can be built over them. */
const APP_FACTS_SWITCHES = appFactsSwitches({
  version: "0.0.0",
  platform: "darwin",
  arch: "arm64",
  locale: "en-US",
  physicalMemoryBytes: 17_179_869_184,
});

let userData: string;

beforeEach(async () => {
  electronMock.reset();
  // The mock's `app.quit` is one spy for the whole file; each case counts its own calls.
  vi.clearAllMocks();
  electronMock.setDisplayWorkAreas([PRIMARY_WORK_AREA]);
  userData = await mkdtemp(path.join(tmpdir(), "sidekicks-window-registry-test-"));
});

afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** The appearance a registry is built over, which a case changes and announces by hand. */
interface ChangingAppearance {
  ground: string;
  record: AppearanceRecord;
  readonly subscribe: (listener: () => void) => () => void;
  /** Tells the registry the record or the platform's scheme changed. */
  readonly announce: () => void;
}

function changingAppearance(): ChangingAppearance {
  const listeners: (() => void)[] = [];
  return {
    ground: MERIDIAN_GROUNDS.light,
    record: DEFAULT_APPEARANCE_RECORD,
    subscribe: (listener) => {
      listeners.push(listener);
      return () => undefined;
    },
    announce: () => {
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

/** A registry over the place file in this case's folder, for one platform, and its log. */
async function createRegistry(
  platform: NodeJS.Platform,
  appearance: ChangingAppearance = changingAppearance(),
) {
  vi.resetModules();
  const { OpenWindows } = await import("./registry.js");
  const { WindowPlaceFile, WINDOW_PLACES_FILE_NAME } = await import("./places/file.js");
  const { screen } = (await import("electron")) as unknown as {
    screen: ConstructorParameters<typeof OpenWindows>[0]["screen"];
  };
  const { log } = testWindowFrame();
  const openWindows = new OpenWindows({
    placeFile: new WindowPlaceFile(path.join(userData, WINDOW_PLACES_FILE_NAME), log),
    screen,
    appearance,
    log,
    platform,
  });
  return { openWindows, log };
}

/** A registry over the place file in this case's folder, for one platform. */
async function createOpenWindows(platform: NodeJS.Platform) {
  return (await createRegistry(platform)).openWindows;
}

/** A registry with its lifecycle installed on the mock's `app`, whose `quit` a case counts. */
async function startedRegistry(platform: NodeJS.Platform) {
  const openWindows = await createOpenWindows(platform);
  const app = ((await import("electron")) as unknown as { app: { quit: ReturnType<typeof vi.fn> } })
    .app;
  openWindows.installLifecycle(app as never);
  return { openWindows, app };
}

/** Every hidden window built so far, oldest first: the windows that loaded the renderer. */
function hiddenWindows(): MockBaseWindow[] {
  return electronMock.constructed.filter(
    (built) => built.contentView.children[0]?.options.webContents === undefined,
  );
}

/** The hidden window built last. */
function latestHiddenWindow(): MockBaseWindow {
  return hiddenWindows().at(-1) ?? expect.fail("a hidden window was built");
}

/** What main sent the console document the hidden window built last holds. */
function sentToConsoleDocument(): readonly { channel: string; value: unknown }[] {
  return latestHiddenWindow().contentView.children[0]?.webContents.sent ?? [];
}

/** The renderer switches the hidden window built `index`th was started with. */
function hiddenWindowSwitches(index: number): string[] {
  return hiddenWindows()[index]?.contentView.children[0]?.options.webPreferences[
    "additionalArguments"
  ] as string[];
}

/** The window used last that the preload hands the `index`th console document. */
async function lastUsedWindowIdOf(index: number): Promise<string> {
  const { createPreloadApi } = await import("#preload/api.js");
  return createPreloadApi(hiddenWindowSwitches(index)).window.lastUsedWindowId;
}

/** Opens a window under `frameName` from the console document, as its `window.open` does. */
function openChildWindow(frameName: string): MockBaseWindow {
  const answer = windowOpenHandlerOf({
    baseWindow: latestHiddenWindow(),
    view: latestHiddenWindow().contentView.children[0],
  })({ url: "about:blank", frameName }) as { createWindow: (options: object) => unknown };
  answer.createWindow({ webContents: handedDocument() });
  return electronMock.constructed.at(-1) ?? expect.fail("the window was built");
}

/** The window-place file as main last wrote it. */
async function readPlaceFile(): Promise<{ windowUsedLast: string; places: object }> {
  const { WINDOW_PLACES_FILE_NAME } = await import("./places/file.js");
  return JSON.parse(await readFile(path.join(userData, WINDOW_PLACES_FILE_NAME), "utf8")) as {
    windowUsedLast: string;
    places: object;
  };
}

/** The window-place file's text as main last wrote it. */
async function readPlaceFileText(): Promise<string> {
  const { WINDOW_PLACES_FILE_NAME } = await import("./places/file.js");
  return readFile(path.join(userData, WINDOW_PLACES_FILE_NAME), "utf8");
}

/** The renderer's process goes, as the console document reports, and the later task answers it. */
function loseTheRenderer(): void {
  latestHiddenWindow().contentView.children[0]?.webContents.emit(
    "render-process-gone",
    {},
    { reason: "crashed" },
  );
  vi.advanceTimersByTime(0);
}

describe("the hidden window", () => {
  it("is told when a View-menu scheme pick was not kept", async () => {
    const openWindows = await createOpenWindows("darwin");
    openWindows.openHiddenWindow({ additionalArguments: [] });

    openWindows.announceUnkeptScheme();

    expect(sentToConsoleDocument()).toEqual([{ channel: UNKEPT_SCHEME_CHANNEL, value: undefined }]);
  });

  it("is built hidden at start, its document handed the window used last", async () => {
    const openWindows = await createOpenWindows("darwin");

    const hiddenWindow = asMockWindow(
      openWindows.openHiddenWindow({ additionalArguments: APP_FACTS_SWITCHES }),
    );
    hiddenWindow.document.emit("did-finish-load");

    expect(hiddenWindow.baseWindow.showCount).toBe(0);
    expect(hiddenWindow.document.loadedUrls).toEqual([INDEX_URL]);
    expect(openWindows.isConsoleDocument(hiddenWindow.document as never)).toBe(true);
    // A first launch mints the id the console document opens its first window under.
    expect(await lastUsedWindowIdOf(0)).toMatch(/^window\/[\w-]+$/);
  });
});

describe("the windows a person sees, counted", () => {
  it.each(["win32", "linux"] as const)(
    "quit the app on %s when the last one closes, and not before",
    async (platform) => {
      const { openWindows, app } = await startedRegistry(platform);
      openWindows.openHiddenWindow({ additionalArguments: [] });
      const first = openChildWindow("window/w-1");
      const second = openChildWindow("window/w-2");
      const lastPlace = { x: 40, y: 65, width: 1000, height: 700 };
      second.setBounds(lastPlace);

      first.close();
      expect(app.quit).not.toHaveBeenCalled();
      second.close();

      expect(app.quit).toHaveBeenCalledTimes(1);
      // The hidden window stays: it is never one of the windows counted.
      expect(latestHiddenWindow().isDestroyed()).toBe(false);
      // Written before the process could end, so the next start opens it there.
      expect(Object.values((await readPlaceFile()).places)).toEqual([
        { ...lastPlace, isMaximized: false, isFullScreen: false },
      ]);
    },
  );

  it("leave the app running on macOS, where a Dock or menu-bar icon click asks the kept document to reopen one", async () => {
    const { openWindows, app } = await startedRegistry("darwin");
    openWindows.openHiddenWindow({ additionalArguments: APP_FACTS_SWITCHES });
    const only = openChildWindow("window/w-1");
    const lastPlace = { x: 40, y: 65, width: 1000, height: 700 };
    only.setBounds(lastPlace);
    only.emit("focus");

    only.close();
    expect(app.quit).not.toHaveBeenCalled();
    // The last window closed keeps its entry, though no window stays open.
    expect(Object.keys((await readPlaceFile()).places)).toEqual(["window/w-1"]);

    electronMock.emitAppEvent("activate");

    // The console document kept since start is asked for the window used last, which it reopens
    // at its place; nothing is rebuilt.
    expect(hiddenWindows()).toHaveLength(1);
    expect(sentToConsoleDocument()).toEqual([
      { channel: REOPEN_WINDOW_CHANNEL, value: "window/w-1" },
    ]);
    const reopened = openChildWindow("window/w-1");
    expect(reopened.options).toMatchObject(lastPlace);

    // A click on the menu-bar icon does the same: it asks for the window used last again.
    const menuBarIconClicks: (() => void)[] = [];
    const menuBarIcon = {
      on: (eventName: string, listener: () => void) => {
        if (eventName === "click") {
          menuBarIconClicks.push(listener);
        }
      },
      destroy: vi.fn(),
    };
    openWindows.installMenuBarIcon(menuBarIcon as never);
    reopened.close();
    for (const click of menuBarIconClicks) {
      click();
    }
    expect(sentToConsoleDocument()).toEqual([
      { channel: REOPEN_WINDOW_CHANNEL, value: "window/w-1" },
      { channel: REOPEN_WINDOW_CHANNEL, value: "window/w-1" },
    ]);

    // A quit takes the icon off the menu bar at once.
    electronMock.emitAppEvent("before-quit");
    expect(menuBarIcon.destroy).toHaveBeenCalledOnce();
  });

  it.each(["linux", "darwin"] as const)(
    "on %s, count the load-failure page a person closes as the last window",
    async (platform) => {
      const { openWindows, app } = await startedRegistry(platform);
      electronMock.failLoadsContaining(INDEX_URL, new Error("ERR_FILE_NOT_FOUND (-6)"));
      openWindows.openHiddenWindow({ additionalArguments: APP_FACTS_SWITCHES });
      const failurePage = latestHiddenWindow();
      // Shown only with the load-failure document; a Dock click brings it forward.
      await vi.waitFor(() => {
        expect(failurePage.isVisible()).toBe(true);
      });
      electronMock.emitAppEvent("activate");
      expect(failurePage.focusCount).toBe(1);
      expect(sentToConsoleDocument()).toEqual([]);

      failurePage.close();

      expect(app.quit).toHaveBeenCalledTimes(platform === "darwin" ? 0 : 1);
      // On macOS the app stays, and a Dock click builds the hidden window again.
      electronMock.emitAppEvent("activate");
      expect(hiddenWindows()).toHaveLength(2);
      expect(hiddenWindowSwitches(1).slice(0, -1)).toEqual(APP_FACTS_SWITCHES);
      // A page that cannot be served is destroyed, and the exit that follows is the answer.
      latestHiddenWindow().destroy();
      expect(app.quit).toHaveBeenCalledTimes(platform === "darwin" ? 0 : 1);
    },
  );

  it("close at a quit once the hidden window's document is gone, and quit nothing more", async () => {
    const { openWindows, app } = await startedRegistry("linux");
    openWindows.openHiddenWindow({ additionalArguments: [] });
    const hiddenDocument = latestHiddenWindow().contentView.children[0]?.webContents;
    const first = openChildWindow("window/w-1");
    const second = openChildWindow("window/w-2");
    const isDocumentGoneAtEachClose: boolean[] = [];
    for (const child of [first, second]) {
      child.on("close", () =>
        isDocumentGoneAtEachClose.push(hiddenDocument?.isDestroyed() === true),
      );
    }

    electronMock.emitAppEvent("before-quit");

    expect([latestHiddenWindow(), first, second].every((each) => each.isDestroyed())).toBe(true);
    // Never while the console document could hear a close as a person's and prune its layout.
    expect(isDocumentGoneAtEachClose).toEqual([true, true]);
    // The quit under way is the only one: a second would hold it for another flush.
    expect(app.quit).not.toHaveBeenCalled();
    // A Dock click or a second launch during the quit's flush opens nothing.
    electronMock.emitAppEvent("activate");
    electronMock.emitAppEvent("second-instance");
    expect(hiddenWindows()).toHaveLength(1);

    // A hidden window already closed, as a probe closing every window does, is left as it is.
    const { openWindows: again } = await startedRegistry("linux");
    again.openHiddenWindow({ additionalArguments: [] });
    latestHiddenWindow().close();
    expect(() => electronMock.emitAppEvent("before-quit")).not.toThrow();
    expect(Object.keys((await readPlaceFile()).places).sort()).toEqual([
      "window/w-1",
      "window/w-2",
    ]);
  });
});

describe("a second launch", () => {
  it("builds nothing before start, then brings the window used last forward", async () => {
    const { openWindows } = await startedRegistry("darwin");

    // Heard while the app is still starting: start is about to build the window itself.
    electronMock.emitAppEvent("second-instance");
    electronMock.emitAppEvent("activate");
    expect(electronMock.constructed).toHaveLength(0);

    openWindows.openHiddenWindow({ additionalArguments: APP_FACTS_SWITCHES });
    const usedLastId = await lastUsedWindowIdOf(0);
    const usedLast = openChildWindow(usedLastId);
    const focusesBefore = usedLast.focusCount;
    electronMock.emitAppEvent("second-instance");

    expect(hiddenWindows()).toHaveLength(1);
    expect(usedLast.focusCount).toBe(focusesBefore + 1);

    // With no window a person sees, it asks the console document to reopen it, as a Dock click.
    usedLast.close();
    electronMock.emitAppEvent("second-instance");
    expect(hiddenWindows()).toHaveLength(1);
    expect(sentToConsoleDocument()).toEqual([
      { channel: REOPEN_WINDOW_CHANNEL, value: usedLastId },
    ]);
  });
});

describe("the renderer's process going away", () => {
  beforeEach(() => {
    // Only the timers: the place file is real and read through the file system's own promises.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  it("builds the hidden window again on a later task and closes the windows that lost it", async () => {
    const { openWindows, app } = await startedRegistry("linux");
    openWindows.openHiddenWindow({ additionalArguments: APP_FACTS_SWITCHES });
    const lostHiddenWindow = latestHiddenWindow();
    const first = openChildWindow("window/w-1");
    const second = openChildWindow("window/w-2");
    const pane = openChildWindow("pane/terminal/s-1");
    const secondPlace = { x: 200, y: 125, width: 900, height: 600 };
    second.setBounds(secondPlace);
    second.emit("focus");

    lostHiddenWindow.contentView.children[0]?.webContents.emit(
      "render-process-gone",
      {},
      { reason: "crashed", exitCode: 11 },
    );

    // Nothing is reloaded or closed inside the handler.
    expect(hiddenWindows()).toHaveLength(1);
    expect(first.isDestroyed()).toBe(false);
    vi.advanceTimersByTime(0);

    // The hidden window built again, with start's switches and the window used last.
    expect(hiddenWindows()).toHaveLength(2);
    expect(hiddenWindowSwitches(1).slice(0, -1)).toEqual(hiddenWindowSwitches(0).slice(0, -1));
    expect(await lastUsedWindowIdOf(1)).toBe("window/w-2");
    expect([lostHiddenWindow, first, second, pane].every((lost) => lost.isDestroyed())).toBe(true);
    expect(latestHiddenWindow().isDestroyed()).toBe(false);
    // Every window a person saw closed, but a lost renderer is no last window closing.
    expect(app.quit).not.toHaveBeenCalled();
    // Every lost window's place is kept for the reloaded renderer to reopen it at.
    const kept = await readPlaceFile();
    expect(Object.keys(kept.places).sort()).toEqual(
      ["window/w-1", "window/w-2", "pane/terminal"].sort(),
    );
    expect(kept.places).toMatchObject({ "window/w-2": secondPlace });
  });

  it("closes the windows a replaced console document drew, keeping their places, on no quit", async () => {
    const { openWindows, app } = await startedRegistry("linux");
    openWindows.openHiddenWindow({ additionalArguments: APP_FACTS_SWITCHES });
    const consoleDocument = latestHiddenWindow().contentView.children[0]?.webContents;
    const first = openChildWindow("window/w-1");
    const pane = openChildWindow("pane/terminal/s-1");

    // A same-document navigation (the console document's own hash) replaces nothing.
    consoleDocument?.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    expect(first.isDestroyed()).toBe(false);

    // A reload: a new console document, which opens its windows again.
    consoleDocument?.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });

    expect([first, pane].every((drawn) => drawn.isDestroyed())).toBe(true);
    expect(latestHiddenWindow().isDestroyed()).toBe(false);
    expect(app.quit).not.toHaveBeenCalled();
    expect(Object.keys((await readPlaceFile()).places).sort()).toEqual(
      ["window/w-1", "pane/terminal"].sort(),
    );
    // Reopened by the new document, a window is tracked again, and its close is a person's.
    openChildWindow("window/w-1").close();
    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  it("logs the loss with its reason and exit code", async () => {
    const { openWindows, log } = await createRegistry("linux");
    openWindows.openHiddenWindow({ additionalArguments: [] });

    latestHiddenWindow().contentView.children[0]?.webContents.emit(
      "render-process-gone",
      {},
      { reason: "oom", exitCode: 11 },
    );
    vi.advanceTimersByTime(0);

    expect(loggedMessages(log)).toEqual([expect.stringContaining("oom, exit code 11")]);
  });

  it("reloads twice from the kept layout, then as a safe start that keeps every place", async () => {
    const { openWindows } = await startedRegistry("darwin");
    openWindows.openHiddenWindow({ additionalArguments: [] });
    openChildWindow("window/w-2").setBounds({ x: 200, y: 125, width: 900, height: 600 });
    for (const crash of [1, 2]) {
      loseTheRenderer();
      expect(openWindows.isSafeStart, `crash ${String(crash)}`).toBe(false);
      // The reloaded renderer reopens the window from its kept layout.
      openChildWindow("window/w-2");
    }
    const keptBefore = await readPlaceFileText();
    // Moved since its place was kept: the safe start keeps the place it had.
    electronMock.constructed.at(-1)?.setBounds({ x: 260, y: 165, width: 700, height: 500 });

    loseTheRenderer();

    expect(openWindows.isSafeStart).toBe(true);
    // The safe start builds the hidden window alone; every window that lost its document closed.
    expect(electronMock.constructed.filter((built) => !built.isDestroyed())).toEqual([
      latestHiddenWindow(),
    ]);
    // Neither the loss, a reload of the safe start's document, closing the safe start's window,
    // nor quitting changes a kept place.
    const safeStartWindow = openChildWindow("window/w-2");
    safeStartWindow.setBounds({ x: 300, y: 225, width: 800, height: 500 });
    latestHiddenWindow().contentView.children[0]?.webContents.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: false,
    });
    expect(safeStartWindow.isDestroyed()).toBe(true);
    openChildWindow("window/w-2").setBounds({ x: 320, y: 245, width: 800, height: 500 });
    electronMock.emitAppEvent("before-quit");
    expect(await readPlaceFileText()).toBe(keptBefore);
  });

  it("keeps places again once the console document ends the safe start", async () => {
    const { openWindows } = await startedRegistry("darwin");
    openWindows.openHiddenWindow({ additionalArguments: [] });
    for (const _crash of [1, 2, 3]) {
      loseTheRenderer();
    }
    expect(openWindows.isSafeStart).toBe(true);

    // `Restore windows` reopened the kept windows.
    openWindows.endSafeStart();
    const restored = openChildWindow("window/w-2");
    const movedPlace = { x: 300, y: 225, width: 800, height: 500 };
    restored.setBounds(movedPlace);
    restored.close();

    expect(openWindows.isSafeStart).toBe(false);
    expect((await readPlaceFile()).places).toMatchObject({ "window/w-2": movedPlace });
  });

  it("reloads nothing once a quit has begun before the later task", async () => {
    const { openWindows } = await startedRegistry("linux");
    openWindows.openHiddenWindow({ additionalArguments: [] });
    latestHiddenWindow().contentView.children[0]?.webContents.emit(
      "render-process-gone",
      {},
      { reason: "crashed" },
    );

    electronMock.emitAppEvent("before-quit");
    vi.advanceTimersByTime(0);

    expect(hiddenWindows()).toHaveLength(1);
  });

  it("clears the count once a reloaded renderer runs five minutes without a loss", async () => {
    const { CRASH_COUNT_CLEARS_AFTER_MS } = await import("./renderer-crashes.js");
    const { openWindows } = await createRegistry("linux");
    openWindows.openHiddenWindow({ additionalArguments: [] });
    loseTheRenderer();
    loseTheRenderer();

    // A loss a moment short of five minutes counts on, to the third in a row.
    vi.advanceTimersByTime(CRASH_COUNT_CLEARS_AFTER_MS - 1);
    loseTheRenderer();
    expect(openWindows.isSafeStart).toBe(true);
    // Past the run the earlier reload started: that loss cleared its timer, so the count holds.
    vi.advanceTimersByTime(2);
    loseTheRenderer();
    expect(openWindows.isSafeStart).toBe(true);

    vi.advanceTimersByTime(CRASH_COUNT_CLEARS_AFTER_MS);
    loseTheRenderer();
    expect(openWindows.isSafeStart).toBe(false);
  });
});

describe("a window the console document opens", () => {
  it("is main's own window around the handed document, never the page's options", async () => {
    const openWindows = await createOpenWindows("darwin");
    const hiddenWindow = openWindows.openHiddenWindow({ additionalArguments: [] });
    openWindows.setDefaultSizes(HANDED_SIZES);
    const handed = handedDocument();

    const answer = windowOpenHandlerOf(hiddenWindow)({
      url: "about:blank",
      frameName: "window/w-1",
    }) as {
      action: string;
      createWindow: (options: object) => unknown;
    };
    // What Chromium would build from the page's `features` string.
    const returned = answer.createWindow({
      webContents: handed,
      width: 50,
      height: 50,
      x: -9999,
      frame: false,
    });

    expect(answer.action).toBe("allow");
    expect(returned).toBe(handed);
    // The first window a person sees opens centered; with no place kept, the next cascades a step
    // down and to the right of it.
    const first = electronMock.constructed[1] ?? expect.fail("the window was built");
    expect(first.options).toMatchObject({ ...CENTERED_ON_PRIMARY, show: false });
    expect(first.showCount).toBe(1);
    expect(openChildWindow("window/w-2").options).toMatchObject({
      ...CENTERED_ON_PRIMARY,
      x: CENTERED_ON_PRIMARY.x + 30,
      y: CENTERED_ON_PRIMARY.y + 30,
    });
    // Cascaded off the first again, it steps past the window already sitting there, giving up what
    // would pass the work area's edges rather than landing back over it.
    first.emit("focus");
    expect(openChildWindow("window/w-3").options).toMatchObject({
      x: CENTERED_ON_PRIMARY.x + 60,
      y: CENTERED_ON_PRIMARY.y + 60,
      width: CENTERED_ON_PRIMARY.width - 30,
      height: CENTERED_ON_PRIMARY.height - 30,
    });
    expect(electronMock.constructedViews[1]?.options).toMatchObject({
      webContents: handed,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
  });

  it("opens a pane's own window with no kept place at the handed width and the work area's height", async () => {
    const openWindows = await createOpenWindows("darwin");
    openWindows.openHiddenWindow({ additionalArguments: [] });
    openWindows.setDefaultSizes(HANDED_SIZES);
    const pane = openChildWindow("pane/terminal/s-1");
    pane.close();

    expect(pane.options).toMatchObject({ ...PRIMARY_WORK_AREA, x: 480, width: 480 });

    // A pane wider than the display is held to it.
    openWindows.setDefaultSizes({ paneWidths: { inspector: 5000 } });
    expect(openChildWindow("pane/inspector/s-1").options).toMatchObject(PRIMARY_WORK_AREA);
  });

  it("is refused under a name main builds nothing for, or for a non-blank document", async () => {
    const openWindows = await createOpenWindows("darwin");
    const hiddenWindow = openWindows.openHiddenWindow({ additionalArguments: [] });

    expect(windowOpenHandlerOf(hiddenWindow)({ url: "about:blank", frameName: "_blank" })).toEqual({
      action: "deny",
    });
    // A second console document would be a second renderer with stores of its own.
    expect(windowOpenHandlerOf(hiddenWindow)({ url: INDEX_URL, frameName: "window/w-3" })).toEqual({
      action: "deny",
    });
    expect(electronMock.constructed).toHaveLength(1);
  });

  it("is found by its window id, the frame name it was opened under, and by nothing else", async () => {
    const openWindows = await createOpenWindows("darwin");
    openWindows.openHiddenWindow({ additionalArguments: [] });
    const second = openChildWindow("window/w-2");
    const pane = openChildWindow("pane/terminal/s-1");

    expect(openWindows.windowWithId("window/w-2")).toBe(second);
    expect(openWindows.windowWithId("pane/terminal/s-1")).toBe(pane);
    expect(openWindows.windowWithId("window/w-3")).toBeUndefined();
    // Neither the bare key nor the pane's place key names a window.
    expect(openWindows.windowWithId("w-2")).toBeUndefined();
    expect(openWindows.windowWithId("pane/terminal")).toBeUndefined();
    expect(openWindows.isConsoleDocument(pane.contentView.children[0]?.webContents as never)).toBe(
      false,
    );

    second.close();
    expect(openWindows.windowWithId("window/w-2")).toBeUndefined();
  });
});

describe("the pushes to the console document", () => {
  it("carry appearance to it alone, and repaint every ground", async () => {
    const appearance = changingAppearance();
    const { openWindows } = await createRegistry("darwin", appearance);
    const hiddenWindow = asMockWindow(openWindows.openHiddenWindow({ additionalArguments: [] }));
    const child = openChildWindow("window/w-2");
    const pane = openChildWindow("pane/terminal/s-1");

    appearance.record = { ...DEFAULT_APPEARANCE_RECORD, scheme: "dark" };
    appearance.ground = MERIDIAN_GROUNDS.dark;
    appearance.announce();
    // The platform's scheme moving repaints, and pushes no record that did not change.
    appearance.announce();

    expect(hiddenWindow.document.sent).toEqual([
      { channel: APPEARANCE_VALUE_CHANNEL, value: appearance.record },
    ]);
    expect(child.contentView.children[0]?.webContents.sent).toEqual([]);
    for (const window of [hiddenWindow.baseWindow, child, pane]) {
      expect(window.backgroundColor).toBe(MERIDIAN_GROUNDS.dark);
      expect(window.contentView.children[0]?.backgroundColor).toBe(MERIDIAN_GROUNDS.dark);
    }
  });
});

describe("the window-place file", () => {
  it("hands the console document the id it keeps the window under, a new one on a first launch", async () => {
    const firstLaunch = await createOpenWindows("darwin");
    firstLaunch.openHiddenWindow({ additionalArguments: APP_FACTS_SWITCHES });
    const mintedId = await lastUsedWindowIdOf(0);
    const first = openChildWindow(mintedId);
    const firstPlace = { x: 40, y: 65, width: 1000, height: 700 };
    first.setBounds(firstPlace);
    first.close();

    const kept = await readPlaceFile();
    expect(kept.windowUsedLast).toBe(mintedId);
    expect(Object.keys(kept.places)).toEqual([mintedId]);

    electronMock.reset();
    const nextStart = await createOpenWindows("darwin");
    nextStart.openHiddenWindow({ additionalArguments: APP_FACTS_SWITCHES });

    // The same id comes back, and its window opens at the place kept under it.
    expect(await lastUsedWindowIdOf(0)).toBe(mintedId);
    expect(openChildWindow(mintedId).options).toMatchObject(firstPlace);
  });

  it("hands the window used last at a quit to the next start, opened at its own place", async () => {
    const { openWindows } = await startedRegistry("darwin");
    openWindows.openHiddenWindow({ additionalArguments: [] });
    const first = openChildWindow("window/w-1");
    const second = openChildWindow("window/w-2");
    const secondPlace = { x: 200, y: 125, width: 900, height: 600 };
    second.setBounds(secondPlace);
    second.emit("focus");

    // Focus lands on each window left as the quit closes them.
    second.on("close", () => {
      first.emit("focus");
    });
    electronMock.emitAppEvent("before-quit");

    electronMock.reset();
    const after = await createOpenWindows("darwin");
    after.openHiddenWindow({ additionalArguments: APP_FACTS_SWITCHES });

    expect(await lastUsedWindowIdOf(0)).toBe("window/w-2");
    expect(openChildWindow("window/w-2").options).toMatchObject(secondPlace);
  });

  it("keeps only the windows open at a quit, dropping one closed while others stay", async () => {
    const { openWindows } = await startedRegistry("darwin");
    openWindows.openHiddenWindow({ additionalArguments: [] });
    openChildWindow("window/w-1");
    const second = openChildWindow("window/w-2");
    const third = openChildWindow("window/w-3");
    third.emit("focus");
    second.emit("focus");

    // Closed while two stay open: its entry goes at once, and the one used before it is used last.
    second.close();
    expect(Object.keys((await readPlaceFile()).places)).not.toContain("window/w-2");
    electronMock.emitAppEvent("before-quit");

    const atQuit = await readPlaceFile();
    expect(Object.keys(atQuit.places).sort()).toEqual(["window/w-1", "window/w-3"]);
    expect(atQuit.windowUsedLast).toBe("window/w-3");
  });

  it("keeps a pane kind's place when its window closes, and across a quit", async () => {
    const { openWindows } = await startedRegistry("darwin");
    openWindows.openHiddenWindow({ additionalArguments: [] });
    openChildWindow("window/w-1");
    const pane = openChildWindow("pane/terminal/s-1");
    const panePlace = { x: 300, y: 100, width: 600, height: 875 };
    pane.setBounds(panePlace);

    pane.close();
    electronMock.emitAppEvent("before-quit");

    expect((await readPlaceFile()).places).toMatchObject({ "pane/terminal": panePlace });
  });

  it("puts a window back where it closed, pulled onto a display it is off", async () => {
    const before = await createOpenWindows("darwin");
    before.openHiddenWindow({ additionalArguments: [] });
    const first = openChildWindow("window/w-1");
    // Moved onto a second display, then that display is detached before the next start.
    first.setFullScreen(true);
    const secondDisplay = { x: 1440, y: 0, width: 1920, height: 1080 };
    electronMock.setDisplayWorkAreas([PRIMARY_WORK_AREA, secondDisplay]);
    first.setBounds({ x: 1600, y: 100, width: 1600, height: 900 });
    first.close();

    electronMock.reset();
    electronMock.setDisplayWorkAreas([PRIMARY_WORK_AREA]);
    const after = await createOpenWindows("darwin");
    after.openHiddenWindow({ additionalArguments: [] });
    const reopened = openChildWindow("window/w-1");

    // Shrunk to the one display left, moved wholly onto it, and fullscreen again.
    expect(reopened.options).toMatchObject({ x: 0, y: 25, width: 1440, height: 875 });
    expect(reopened.isFullScreen()).toBe(true);
  });

  it("opens at the default size when the file is broken, and rewrites it", async () => {
    const { WINDOW_PLACES_FILE_NAME } = await import("./places/file.js");
    await writeFile(path.join(userData, WINDOW_PLACES_FILE_NAME), "{ not json", "utf8");

    const { openWindows, log } = await createRegistry("darwin");
    openWindows.openHiddenWindow({ additionalArguments: [] });

    expect(openChildWindow("window/w-1").options).toMatchObject(CENTERED_ON_PRIMARY);
    expect(await readPlaceFile()).toEqual({ places: {} });
    expect(loggedMessages(log)).toEqual([expect.stringContaining("is not JSON")]);
  });

  it("drops the entries the schema refuses and rewrites the file with the rest", async () => {
    const { WINDOW_PLACES_FILE_NAME } = await import("./places/file.js");
    const keptPlace = { x: 40, y: 65, width: 1000, height: 700, isMaximized: false };
    await writeFile(
      path.join(userData, WINDOW_PLACES_FILE_NAME),
      JSON.stringify({
        windowUsedLast: "window/w-1",
        places: {
          "window/w-1": { ...keptPlace, isFullScreen: false },
          "window/w-2": { ...keptPlace, width: -5, isFullScreen: false },
        },
      }),
      "utf8",
    );

    const { openWindows, log } = await createRegistry("darwin");
    openWindows.openHiddenWindow({ additionalArguments: [] });

    expect(openChildWindow("window/w-1").options).toMatchObject({ x: 40, y: 65, width: 1000 });
    expect(await readPlaceFile()).toEqual({
      windowUsedLast: "window/w-1",
      places: { "window/w-1": { ...keptPlace, isFullScreen: false } },
    });
    expect(loggedMessages(log)).toEqual([expect.stringContaining("refused entries")]);
  });

  it("records a place it could not write in main's log, and the window still closes", async () => {
    const { WINDOW_PLACES_FILE_NAME } = await import("./places/file.js");
    const { openWindows, log } = await createRegistry("darwin");
    openWindows.openHiddenWindow({ additionalArguments: [] });
    const first = openChildWindow("window/w-1");
    // A folder where the file goes: the rename over it fails.
    await mkdir(path.join(userData, WINDOW_PLACES_FILE_NAME));

    first.close();

    expect(first.isDestroyed()).toBe(true);
    expect(loggedMessages(log)).toEqual([expect.stringContaining("were not kept")]);
  });
});
