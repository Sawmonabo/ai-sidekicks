// The `window` members end to end, from the preload's object through Electron's IPC (mocked, with
// its structured cloning) to main's answers: a chosen appearance is kept and comes back as the
// first delivery of a subscription, and a request the schema refuses changes nothing; a member
// naming one window acts on that window alone, and only for the console document.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppearanceRecord } from "#shared/appearance.js";
import { FULLSCREEN_VALUE_CHANNEL, type FullscreenPush } from "#shared/bridge-channels.js";
import { createElectronMock } from "#test/helpers/electron/mock/electron-mock.js";

const electronMock = createElectronMock();

vi.mock("electron", () => electronMock.moduleExports);

const CHOICE = { theme: "meridian", scheme: "light", textSize: 18, transcriptWidth: 42 } as const;
const GROUNDS = { light: "#fbfaf7", dark: "#141516" } as const;
/** The work area of the one display the asking window is on. */
const WORK_AREA = { x: 0, y: 25, width: 1440, height: 875 };

/** The one window open, under its id, the frame name it was opened under. */
const OPEN_WINDOW_ID = "window/w-2";

let userData: string;
let appearanceFilePath: string;
let minimumSizes: [number, number][];
/** Whether the asking document is the console document. */
let isAskedFromTheConsole: boolean;
/** What main pushes on one channel, handed to the listeners the preload registered for it. */
let pushToThePage: (channel: string, value: unknown) => void;

/** The preload's `window` member over the mocked IPC, answered by main's real handlers. */
async function connectWindowBridge() {
  vi.resetModules();
  const { ipcMain, ipcRenderer, nativeTheme } = (await import("electron")) as unknown as {
    ipcMain: { handle(channel: string, answer: (...args: never[]) => unknown): void };
    ipcRenderer: Parameters<typeof import("#preload/window-bridge.js").createWindowBridge>[0];
    nativeTheme: never;
  };
  const { windowAnswers } = await import("./window-handlers.js");
  const { KeptAppearance } = await import("../appearance/kept-appearance.js");
  const { AppearanceRecordFile } = await import("../appearance/record-file.js");
  const { createWindowBridge } = await import("#preload/window-bridge.js");
  const appearance = new KeptAppearance({
    file: new AppearanceRecordFile({
      filePath: appearanceFilePath,
      log: { write: vi.fn() },
      now: () => new Date(),
    }),
    nativeTheme,
  });
  const openWindow = {
    setMinimumSize: (width: number, height: number) => {
      minimumSizes.push([width, height]);
    },
    getBounds: () => ({ x: 100, y: 100, width: 900, height: 600 }),
    isFullScreen: () => false,
  };
  for (const [channel, answer] of Object.entries(
    windowAnswers({
      appearance,
      openWindows: {
        isConsoleDocument: () => isAskedFromTheConsole,
        windowWithId: (windowId) =>
          windowId === OPEN_WINDOW_ID ? (openWindow as never) : undefined,
        windowUsedLast: () => undefined,
        setDefaultSizes: () => undefined,
      },
    }),
  )) {
    ipcMain.handle(channel, answer as never);
  }
  const pageListeners = new Map<string, (event: unknown, ...args: unknown[]) => void>();
  pushToThePage = (channel, value) => {
    pageListeners.get(channel)?.({}, structuredClone(value));
  };
  return createWindowBridge(
    {
      invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
      on: (channel, listener) => pageListeners.set(channel, listener),
    },
    OPEN_WINDOW_ID,
  );
}

beforeEach(async () => {
  electronMock.reset();
  electronMock.setDisplayWorkAreas([WORK_AREA]);
  userData = await mkdtemp(path.join(tmpdir(), "sidekicks-window-bridge-test-"));
  appearanceFilePath = path.join(userData, "appearance.json");
  minimumSizes = [];
  isAskedFromTheConsole = true;
});

afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

describe("the window members", () => {
  it("keep a chosen appearance and hand it to a subscription as its first delivery", async () => {
    const windowBridge = await connectWindowBridge();

    await windowBridge.setAppearance(CHOICE, GROUNDS);
    const deliveries: AppearanceRecord[] = [];
    windowBridge.subscribeAppearance((record) => {
      deliveries.push(record);
    });

    await vi.waitFor(() => {
      expect(deliveries).toStrictEqual([{ ...CHOICE, grounds: GROUNDS }]);
    });
    expect(JSON.parse(await readFile(appearanceFilePath, "utf8"))).toStrictEqual({
      ...CHOICE,
      grounds: GROUNDS,
    });
  });

  it("refuse an appearance the schema refuses, and keep nothing", async () => {
    const windowBridge = await connectWindowBridge();

    await expect(
      windowBridge.setAppearance(CHOICE, { light: "white", dark: GROUNDS.dark }),
    ).rejects.toThrow();
    await expect(
      windowBridge.setAppearance({ ...CHOICE, textSize: 17 } as never, GROUNDS),
    ).rejects.toThrow();
    await expect(
      windowBridge.setAppearance({ ...CHOICE, transcriptWidth: 35 }, GROUNDS),
    ).rejects.toThrow();

    await expect(readFile(appearanceFilePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("set a named window's minimum size in whole pixels within its display, and refuse the rest", async () => {
    const windowBridge = await connectWindowBridge();

    await windowBridge.setMinimumSize(OPEN_WINDOW_ID, { width: 640.2, height: 480 });
    // Past the display's work area on either side: held to it, so the window still fits.
    await windowBridge.setMinimumSize(OPEN_WINDOW_ID, { width: 3000, height: 2000 });
    await expect(
      windowBridge.setMinimumSize(OPEN_WINDOW_ID, { width: 0, height: 480 }),
    ).rejects.toThrow();
    await expect(
      windowBridge.setMinimumSize(OPEN_WINDOW_ID, { width: Number.NaN, height: 480 }),
    ).rejects.toThrow();
    // A window no open frame name carries, and a document other than the console's.
    await expect(
      windowBridge.setMinimumSize("window/w-9", { width: 640, height: 480 }),
    ).rejects.toThrow("No open window has that id");
    isAskedFromTheConsole = false;
    await expect(
      windowBridge.setMinimumSize(OPEN_WINDOW_ID, { width: 640, height: 480 }),
    ).rejects.toThrow("Only the console document asks");

    expect(minimumSizes).toStrictEqual([
      [641, 480],
      [WORK_AREA.width, WORK_AREA.height],
    ]);
  });

  it("deliver each window's fullscreen to that window's subscriptions alone", async () => {
    const windowBridge = await connectWindowBridge();
    const deliveries: string[] = [];
    windowBridge.subscribeFullscreen(OPEN_WINDOW_ID, (isFullScreen) => {
      deliveries.push(`${OPEN_WINDOW_ID}:${String(isFullScreen)}`);
    });
    await vi.waitFor(() => {
      expect(deliveries).toStrictEqual([`${OPEN_WINDOW_ID}:false`]);
    });

    const pushes: FullscreenPush[] = [
      { windowId: "pane/terminal/s-1", isFullScreen: true },
      { windowId: OPEN_WINDOW_ID, isFullScreen: true },
    ];
    for (const push of pushes) {
      pushToThePage(FULLSCREEN_VALUE_CHANNEL, push);
    }

    expect(deliveries).toStrictEqual([`${OPEN_WINDOW_ID}:false`, `${OPEN_WINDOW_ID}:true`]);
  });
});
