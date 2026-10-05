// Main's registry of windows: the platform-correct answer to the last window closing, a second
// launch and a Dock click, before start and after it; the renderer's process going away, answered
// on a later task, the third loss in a row a safe start and the count clearing after five quiet
// minutes; the
// window the renderer's `window.open` gets (main's own options and kept place, never the page's,
// centered or cascaded when none is kept); the pushes to the document holding the bridge; and the
// window-place file across a close and a restart: the window used last built first, only the
// console windows open at a quit and the last one closed kept, a pane kind's place always kept, a
// place left off every display, and a file that cannot be parsed. `electron` is mocked; the place
// file is real, in a temporary folder.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { appFactsSwitches } from "@shared/app-facts.js";
import {
  DEFAULT_APPEARANCE_RECORD,
  MERIDIAN_GROUNDS,
  type AppearanceRecord,
} from "@shared/appearance.js";
import { APPEARANCE_VALUE_CHANNEL, FULLSCREEN_VALUE_CHANNEL } from "@shared/bridge-channels.js";
import { createElectronMock } from "@test/helpers/electron-mock.js";
import { createMockWebContents, type MockBaseWindow } from "@test/helpers/electron-mock-window.js";
import {
  asMockWindow,
  INDEX_URL,
  loggedMessages,
  testWindowFrame,
  windowOpenHandlerOf,
} from "@test/helpers/window-test-harness.js";

const electronMock = createElectronMock();

vi.mock("electron", () => electronMock.moduleExports);

/** The one display the mock reports. */
const PRIMARY_WORK_AREA = { x: 0, y: 25, width: 1440, height: 875 };

/** Where a window with no kept place opens on it: centered, at four fifths of its work area. */
const CENTERED_ON_PRIMARY = { x: 144, y: 113, width: 1152, height: 700 };

/** What a document Chromium hands to `createWindow` reports to: nothing the cases read. */
const MOCK_OWNER = {
  record: () => {},
  recordConstruction: () => {},
  recordView: () => {},
  forgetWindow: () => {},
  mintId: () => 500,
  loadFailureFor: () => undefined,
};

/** The app facts a first window is started with, so the preload can be built over its switches. */
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
  userData = await mkdtemp(path.join(tmpdir(), "sidekicks-open-windows-test-"));
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

/** A registry over the place file in this case's folder, for one platform, and the log it writes. */
async function createRegistry(
  platform: NodeJS.Platform,
  appearance: ChangingAppearance = changingAppearance(),
) {
  vi.resetModules();
  const { OpenWindows } = await import("./open-windows.js");
  const { WindowPlaceFile, WINDOW_PLACES_FILE_NAME } = await import("./places/place-file.js");
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

/** The renderer switches the `index`th view built was started with. */
function switchesOfView(index: number): string[] {
  return electronMock.constructedViews[index]?.options.webPreferences[
    "additionalArguments"
  ] as string[];
}

/** The `window.id` the preload exposes to the page of the `index`th view built. */
async function exposedWindowId(index: number): Promise<string> {
  const { createPreloadApi } = await import("@preload/api.js");
  return createPreloadApi(switchesOfView(index)).window.id;
}

/** Opens the renderer's own window under `frameName` from `opener`, as its `window.open` does. */
function openChildWindow(opener: unknown, frameName: string): MockBaseWindow {
  const answer = windowOpenHandlerOf(opener)({ url: "about:blank", frameName }) as {
    createWindow: (options: object) => unknown;
  };
  answer.createWindow({ webContents: createMockWebContents(MOCK_OWNER) });
  return electronMock.constructed.at(-1) ?? expect.fail("the renderer's window was built");
}

/** The window-place file as main last wrote it. */
async function readPlaceFile(): Promise<{ windowUsedLast: string; places: object }> {
  const { WINDOW_PLACES_FILE_NAME } = await import("./places/place-file.js");
  return JSON.parse(await readFile(path.join(userData, WINDOW_PLACES_FILE_NAME), "utf8")) as {
    windowUsedLast: string;
    places: object;
  };
}

/** The `app` the lifecycle is installed on: the mock's, which records listeners and quits. */
async function mockApp(): Promise<{ readonly quit: ReturnType<typeof vi.fn> }> {
  return ((await import("electron")) as unknown as { app: { quit: ReturnType<typeof vi.fn> } }).app;
}

/** The console window the last reload built, with the view its document is in. */
function reloadedConsoleWindow(): { baseWindow: MockBaseWindow; view: unknown } {
  const baseWindow =
    electronMock.constructed.findLast((built) => !built.isDestroyed()) ??
    expect.fail("a console window is open");
  return { baseWindow, view: baseWindow.contentView.children[0] };
}

/** The renderer's process goes, as every open document reports, and the later task answers it. */
function loseTheRenderer(): void {
  for (const built of electronMock.constructed.filter((window) => !window.isDestroyed())) {
    built.contentView.children[0]?.webContents.emit(
      "render-process-gone",
      {},
      { reason: "crashed" },
    );
  }
  vi.advanceTimersByTime(0);
}

/** The renderer reopening its second window from the kept layout, as a reload does. */
function reopenKeptLayout(): void {
  const second = openChildWindow(reloadedConsoleWindow(), "window/w-2");
  second.setBounds({ x: 200, y: 125, width: 900, height: 600 });
}

/** The window-place file's text as main last wrote it. */
async function readPlaceFileText(): Promise<string> {
  const { WINDOW_PLACES_FILE_NAME } = await import("./places/place-file.js");
  return readFile(path.join(userData, WINDOW_PLACES_FILE_NAME), "utf8");
}

describe("closing the last window", () => {
  it("leaves the app running on macOS, and a Dock click reopens that window in place", async () => {
    const openWindows = await createOpenWindows("darwin");
    const app = await mockApp();
    openWindows.installLifecycle(app as never);
    const first = asMockWindow(openWindows.openFirstWindow({ additionalArguments: ["--facts"] }));
    const lastPlace = { x: 40, y: 65, width: 1000, height: 700 };
    first.baseWindow.setBounds(lastPlace);

    first.baseWindow.close();
    electronMock.emitAppEvent("window-all-closed");

    expect(app.quit).not.toHaveBeenCalled();
    // The last window closed keeps its entry, though no window stays open.
    expect(Object.keys((await readPlaceFile()).places)).toHaveLength(1);

    electronMock.emitAppEvent("activate");

    expect(electronMock.constructed).toHaveLength(2);
    expect(electronMock.constructed[1]?.options).toMatchObject(lastPlace);
    // The reopened window starts the renderer with the same switches as the first, its id included.
    expect(switchesOfView(1)).toEqual(switchesOfView(0));
    expect(switchesOfView(1)[0]).toBe("--facts");
  });

  it.each(["win32", "linux"] as const)("quits the app on %s, its place kept", async (platform) => {
    const openWindows = await createOpenWindows(platform);
    const app = await mockApp();
    openWindows.installLifecycle(app as never);
    const first = asMockWindow(openWindows.openFirstWindow({ additionalArguments: [] }));
    const lastPlace = { x: 40, y: 65, width: 1000, height: 700 };
    first.baseWindow.setBounds(lastPlace);
    first.baseWindow.close();

    electronMock.emitAppEvent("window-all-closed");

    expect(app.quit).toHaveBeenCalledTimes(1);
    // Written before the process could end, so the next start opens it there.
    expect(Object.values((await readPlaceFile()).places)).toEqual([
      { ...lastPlace, isMaximized: false, isFullScreen: false },
    ]);
  });
});

describe("a second launch and a Dock click", () => {
  it("build nothing before start has built the first window, then bring it forward", async () => {
    const openWindows = await createOpenWindows("darwin");
    openWindows.installLifecycle((await mockApp()) as never);

    // Heard while the app is still starting: start is about to build the window itself.
    electronMock.emitAppEvent("second-instance");
    electronMock.emitAppEvent("activate");
    expect(electronMock.constructed).toHaveLength(0);

    const first = asMockWindow(openWindows.openFirstWindow({ additionalArguments: [] }));
    const focusesBefore = first.baseWindow.focusCount;
    electronMock.emitAppEvent("second-instance");

    expect(electronMock.constructed).toHaveLength(1);
    expect(first.baseWindow.focusCount).toBe(focusesBefore + 1);
  });
});

describe("the renderer's process going away", () => {
  beforeEach(() => {
    // Only the timers: the place file is real and read through the file system's own promises.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  it("reopens the first window on a later task and closes the others, keeping every place", async () => {
    const { openWindows, log } = await createRegistry("linux");
    const firstWindow = openWindows.openFirstWindow({ additionalArguments: APP_FACTS_SWITCHES });
    const firstId = await exposedWindowId(0);
    const first = asMockWindow(firstWindow);
    const second = openChildWindow(firstWindow, "window/w-2");
    const pane = openChildWindow(firstWindow, "pane/terminal/s-1");
    const secondPlace = { x: 200, y: 125, width: 900, height: 600 };
    second.setBounds(secondPlace);
    let windowsBuiltWhenTheFirstClosed = 0;
    first.baseWindow.on("closed", () => {
      windowsBuiltWhenTheFirstClosed = electronMock.constructed.length;
    });

    first.document.emit("render-process-gone", {}, { reason: "crashed", exitCode: 11 });
    // The other documents shared the process and report it too.
    pane.contentView.children[0]?.webContents.emit("render-process-gone", {}, {});

    // Nothing is reloaded or closed inside the handler.
    expect(electronMock.constructed).toHaveLength(3);
    expect(first.baseWindow.isDestroyed()).toBe(false);
    vi.advanceTimersByTime(0);

    // One window built again, loading the renderer under the same id and switches.
    expect(electronMock.constructed).toHaveLength(4);
    expect(switchesOfView(3)).toEqual(switchesOfView(0));
    expect([first.baseWindow, second, pane].every((lost) => lost.isDestroyed())).toBe(true);
    // Built before the lost windows closed, so no moment had every window closed, which would quit
    // the app on Windows and Linux.
    expect(windowsBuiltWhenTheFirstClosed).toBe(4);
    expect(electronMock.constructed[3]?.isDestroyed()).toBe(false);
    // Every lost window's place is kept for the reloaded renderer to reopen it at.
    const kept = await readPlaceFile();
    expect(Object.keys(kept.places).sort()).toEqual(
      [`window/${firstId}`, "window/w-2", "pane/terminal"].sort(),
    );
    expect(kept.places).toMatchObject({ "window/w-2": secondPlace });
    expect(loggedMessages(log)).toEqual([expect.stringContaining("crashed, exit code 11")]);
  });
  it("reloads twice from the kept layout, then as a safe start that keeps every place", async () => {
    const { openWindows } = await createRegistry("darwin");
    openWindows.installLifecycle((await mockApp()) as never);
    openWindows.openFirstWindow({ additionalArguments: [] });
    reopenKeptLayout();
    for (const crash of [1, 2]) {
      loseTheRenderer();
      expect(openWindows.isSafeStart, `crash ${String(crash)}`).toBe(false);
      // The reloaded renderer reopens the second window from its kept layout.
      reopenKeptLayout();
    }
    const keptBefore = await readPlaceFileText();
    // Moved since its place was kept: the safe start keeps the place it had.
    electronMock.constructed.at(-1)?.setBounds({ x: 260, y: 165, width: 700, height: 500 });

    loseTheRenderer();

    expect(openWindows.isSafeStart).toBe(true);
    // The safe start builds the first window alone, and every window that lost its document closed.
    expect(electronMock.constructed.filter((built) => !built.isDestroyed())).toHaveLength(1);
    // Neither the loss, nor closing the safe start's window, nor quitting changes a kept place.
    const safeStartWindow = electronMock.constructed.at(-1) ?? expect.fail("the window was built");
    safeStartWindow.setBounds({ x: 300, y: 225, width: 800, height: 500 });
    electronMock.emitAppEvent("before-quit");
    safeStartWindow.close();
    expect(await readPlaceFileText()).toBe(keptBefore);
  });

  it("reloads nothing once a quit has begun before the later task", async () => {
    const openWindows = await createOpenWindows("linux");
    openWindows.installLifecycle((await mockApp()) as never);
    asMockWindow(openWindows.openFirstWindow({ additionalArguments: [] })).document.emit(
      "render-process-gone",
      {},
      { reason: "crashed" },
    );

    electronMock.emitAppEvent("before-quit");
    vi.advanceTimersByTime(0);

    expect(electronMock.constructed).toHaveLength(1);
  });

  it("clears the count once a reloaded renderer runs five minutes without a loss", async () => {
    const { CRASH_COUNT_CLEARS_AFTER_MS } = await import("./renderer-crashes.js");
    const { openWindows } = await createRegistry("linux");
    openWindows.openFirstWindow({ additionalArguments: [] });
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

describe("a window the renderer opens", () => {
  it("is main's own window around the handed document, never the page's options", async () => {
    const openWindows = await createOpenWindows("darwin");
    const first = openWindows.openFirstWindow({ additionalArguments: [] });
    const handed = createMockWebContents(MOCK_OWNER);

    const answer = windowOpenHandlerOf(first)({
      url: "about:blank",
      frameName: "window/w-2",
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
    // The first window opens centered; with no place kept, the next cascades off it.
    expect(electronMock.constructed[0]?.options).toMatchObject(CENTERED_ON_PRIMARY);
    expect(electronMock.constructed[1]?.options).toMatchObject({
      x: CENTERED_ON_PRIMARY.x + 30,
      y: CENTERED_ON_PRIMARY.y + 30,
      width: CENTERED_ON_PRIMARY.width,
      height: CENTERED_ON_PRIMARY.height,
      show: false,
    });
    // Cascaded off the first again, it steps past the window already sitting there.
    asMockWindow(first).baseWindow.emit("focus");
    openChildWindow(first, "window/w-3");
    expect(electronMock.constructed[2]?.options).toMatchObject({
      x: CENTERED_ON_PRIMARY.x + 60,
      y: CENTERED_ON_PRIMARY.y + 60,
    });
    expect(electronMock.constructedViews[1]?.options).toMatchObject({
      webContents: handed,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
  });

  it("is refused under a name main builds nothing for, or for a non-blank document", async () => {
    const openWindows = await createOpenWindows("darwin");
    const first = openWindows.openFirstWindow({ additionalArguments: [] });

    expect(windowOpenHandlerOf(first)({ url: "about:blank", frameName: "_blank" })).toEqual({
      action: "deny",
    });
    // A second console document would be a second renderer with stores of its own.
    expect(windowOpenHandlerOf(first)({ url: INDEX_URL, frameName: "window/w-3" })).toEqual({
      action: "deny",
    });
    expect(electronMock.constructed).toHaveLength(1);
  });
});

describe("the pushes to the document holding the bridge", () => {
  it("carry appearance and fullscreen to it alone, and repaint every window's ground", async () => {
    const appearance = changingAppearance();
    const { openWindows } = await createRegistry("darwin", appearance);
    const firstWindow = openWindows.openFirstWindow({ additionalArguments: [] });
    const first = asMockWindow(firstWindow);
    const child = openChildWindow(firstWindow, "window/w-2");
    const childDocument = child.contentView.children[0]?.webContents;

    appearance.record = { ...DEFAULT_APPEARANCE_RECORD, scheme: "dark" };
    appearance.ground = MERIDIAN_GROUNDS.dark;
    appearance.announce();
    // The platform's scheme moving repaints, and pushes no record that did not change.
    appearance.announce();
    first.baseWindow.emit("enter-full-screen");
    child.emit("enter-full-screen");

    expect(first.document.sent).toEqual([
      { channel: APPEARANCE_VALUE_CHANNEL, value: appearance.record },
      { channel: FULLSCREEN_VALUE_CHANNEL, value: true },
    ]);
    expect(childDocument?.sent).toEqual([]);
    for (const window of [first.baseWindow, child]) {
      expect(window.backgroundColor).toBe(MERIDIAN_GROUNDS.dark);
      expect(window.contentView.children[0]?.backgroundColor).toBe(MERIDIAN_GROUNDS.dark);
    }
  });
});

describe("the window-place file", () => {
  it("hands the first window the id it is kept under, a new one on a first launch", async () => {
    const firstLaunch = await createOpenWindows("darwin");
    const first = asMockWindow(
      firstLaunch.openFirstWindow({ additionalArguments: APP_FACTS_SWITCHES }),
    );
    const mintedId = await exposedWindowId(0);
    const firstPlace = { x: 40, y: 65, width: 1000, height: 700 };
    first.baseWindow.setBounds(firstPlace);
    first.baseWindow.close();

    // The page was handed the id main keeps the window under.
    const kept = await readPlaceFile();
    expect(kept.windowUsedLast).toBe(mintedId);
    expect(Object.keys(kept.places)).toEqual([`window/${mintedId}`]);

    electronMock.reset();
    const nextStart = await createOpenWindows("darwin");
    nextStart.openFirstWindow({ additionalArguments: APP_FACTS_SWITCHES });

    // The same id comes back with the place kept under it, so the page's layout finds its window.
    expect(await exposedWindowId(0)).toBe(mintedId);
    expect(electronMock.constructed[0]?.options).toMatchObject(firstPlace);
  });

  it("builds the window used last first at the next start, at its own place", async () => {
    const before = await createOpenWindows("darwin");
    const app = await mockApp();
    before.installLifecycle(app as never);
    const firstWindow = before.openFirstWindow({ additionalArguments: [] });
    const first = asMockWindow(firstWindow);
    const second = openChildWindow(firstWindow, "window/w-2");
    const secondPlace = { x: 200, y: 125, width: 900, height: 600 };
    second.setBounds(secondPlace);
    second.emit("focus");

    // A quit closes the windows one by one, and focus lands on each that is left.
    electronMock.emitAppEvent("before-quit");
    second.close();
    first.baseWindow.emit("focus");
    first.baseWindow.close();

    electronMock.reset();
    const after = await createOpenWindows("darwin");
    after.openFirstWindow({ additionalArguments: APP_FACTS_SWITCHES });

    expect(electronMock.constructed[0]?.options).toMatchObject(secondPlace);
    expect(await exposedWindowId(0)).toBe("w-2");
  });

  it("keeps only the windows open at a quit, dropping one closed while others stay", async () => {
    const before = await createOpenWindows("darwin");
    before.installLifecycle((await mockApp()) as never);
    const firstWindow = before.openFirstWindow({ additionalArguments: APP_FACTS_SWITCHES });
    const firstId = await exposedWindowId(0);
    const second = openChildWindow(firstWindow, "window/w-2");
    const third = openChildWindow(firstWindow, "window/w-3");
    third.emit("focus");
    second.emit("focus");

    // Closed while two stay open: its entry goes at once, and the one used before it is used last.
    second.close();
    expect(Object.keys((await readPlaceFile()).places)).not.toContain("window/w-2");
    electronMock.emitAppEvent("before-quit");
    third.close();
    asMockWindow(firstWindow).baseWindow.close();

    const atQuit = await readPlaceFile();
    expect(Object.keys(atQuit.places).sort()).toEqual([`window/${firstId}`, "window/w-3"].sort());
    expect(atQuit.windowUsedLast).toBe("w-3");

    // The next run opens only the window used last, so its quit forgets the one it never opened.
    electronMock.reset();
    const after = await createOpenWindows("darwin");
    after.installLifecycle((await mockApp()) as never);
    const reopened = asMockWindow(after.openFirstWindow({ additionalArguments: [] }));
    electronMock.emitAppEvent("before-quit");
    reopened.baseWindow.close();

    expect(Object.keys((await readPlaceFile()).places)).toEqual(["window/w-3"]);
  });

  it("keeps a pane kind's place when its window closes, and across a quit", async () => {
    const openWindows = await createOpenWindows("darwin");
    openWindows.installLifecycle((await mockApp()) as never);
    const firstWindow = openWindows.openFirstWindow({ additionalArguments: [] });
    const pane = openChildWindow(firstWindow, "pane/terminal/s-1");
    const panePlace = { x: 300, y: 100, width: 600, height: 875 };
    pane.setBounds(panePlace);

    pane.close();
    electronMock.emitAppEvent("before-quit");
    asMockWindow(firstWindow).baseWindow.close();

    expect((await readPlaceFile()).places).toMatchObject({ "pane/terminal": panePlace });
  });

  it("puts a window back where it closed, pulled onto a display it is off", async () => {
    const before = await createOpenWindows("darwin");
    const first = before.openFirstWindow({ additionalArguments: [] });
    // Moved onto a second display, then that display is detached before the next start.
    asMockWindow(first).baseWindow.setFullScreen(true);
    const secondDisplay = { x: 1440, y: 0, width: 1920, height: 1080 };
    electronMock.setDisplayWorkAreas([PRIMARY_WORK_AREA, secondDisplay]);
    asMockWindow(first).baseWindow.setBounds({ x: 1600, y: 100, width: 1600, height: 900 });
    asMockWindow(first).baseWindow.close();

    electronMock.reset();
    electronMock.setDisplayWorkAreas([PRIMARY_WORK_AREA]);
    const after = await createOpenWindows("darwin");
    const reopened = asMockWindow(after.openFirstWindow({ additionalArguments: [] }));

    // Shrunk to the one display left and moved wholly onto it.
    expect(reopened.baseWindow.options).toMatchObject({ x: 0, y: 25, width: 1440, height: 875 });
    reopened.document.emit("did-finish-load");
    expect(reopened.baseWindow.isFullScreen()).toBe(true);
  });

  it("opens at the default size when the file is broken, and rewrites it", async () => {
    const { WINDOW_PLACES_FILE_NAME } = await import("./places/place-file.js");
    await writeFile(path.join(userData, WINDOW_PLACES_FILE_NAME), "{ not json", "utf8");

    const { openWindows, log } = await createRegistry("darwin");
    openWindows.openFirstWindow({ additionalArguments: [] });

    expect(electronMock.constructed[0]?.options).toMatchObject(CENTERED_ON_PRIMARY);
    expect(await readPlaceFile()).toEqual({ places: {} });
    expect(loggedMessages(log)).toEqual([expect.stringContaining("is not JSON")]);
  });

  it("drops the entries the schema refuses and rewrites the file with the rest", async () => {
    const { WINDOW_PLACES_FILE_NAME } = await import("./places/place-file.js");
    const keptPlace = { x: 40, y: 65, width: 1000, height: 700, isMaximized: false };
    await writeFile(
      path.join(userData, WINDOW_PLACES_FILE_NAME),
      JSON.stringify({
        windowUsedLast: "w-1",
        places: {
          "window/w-1": { ...keptPlace, isFullScreen: false },
          "window/w-2": { ...keptPlace, width: -5, isFullScreen: false },
        },
      }),
      "utf8",
    );

    const { openWindows, log } = await createRegistry("darwin");
    openWindows.openFirstWindow({ additionalArguments: [] });

    expect(electronMock.constructed[0]?.options).toMatchObject({ x: 40, y: 65, width: 1000 });
    expect(await readPlaceFile()).toEqual({
      windowUsedLast: "w-1",
      places: { "window/w-1": { ...keptPlace, isFullScreen: false } },
    });
    expect(loggedMessages(log)).toEqual([expect.stringContaining("refused entries")]);
  });

  it("records a place it could not write in main's log, and the window still closes", async () => {
    const { WINDOW_PLACES_FILE_NAME } = await import("./places/place-file.js");
    const { openWindows, log } = await createRegistry("darwin");
    const first = asMockWindow(openWindows.openFirstWindow({ additionalArguments: [] }));
    // A folder where the file goes: the rename over it fails.
    await mkdir(path.join(userData, WINDOW_PLACES_FILE_NAME));

    first.baseWindow.close();

    expect(first.baseWindow.isDestroyed()).toBe(true);
    expect(loggedMessages(log)).toEqual([expect.stringContaining("were not kept")]);
  });
});
