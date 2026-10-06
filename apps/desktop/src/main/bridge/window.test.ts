// The `window` members end to end, from the preload's object through Electron's IPC (mocked, with
// its structured cloning) to main's answers: a chosen appearance is kept and comes back as the
// first delivery of a subscription, and a request the schema refuses changes nothing; a member
// naming one window acts on that window alone, and brings it forward through main's reveal path;
// the end of a safe start reaches main's registry;
// main's ask to reopen a window reaches the page; and every member answers the console document
// alone.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppearanceRecord } from "#shared/appearance.js";
import { BRIDGE_CHANNELS, REOPEN_WINDOW_CHANNEL } from "#shared/bridge-channels.js";
import { createElectronMock } from "#test/helpers/electron/mock/module.js";

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
/** What bringing the one open window forward asked of it, in order. */
let revealCalls: string[];
/** Whether the asking document is the console document. */
let isAskedFromTheConsole: boolean;
/** How many times main's registry was told the safe start ended. */
let safeStartEnds: number;
/** The listeners the preload put on each channel main pushes on. */
let pushListeners: Map<string, (event: unknown, ...args: unknown[]) => void>;

/** The preload's `window` member over the mocked IPC, answered by main's real handlers. */
async function connectWindowBridge() {
  vi.resetModules();
  const { ipcMain, ipcRenderer, nativeTheme } = (await import("electron")) as unknown as {
    ipcMain: { handle(channel: string, answer: (...args: never[]) => unknown): void };
    ipcRenderer: Parameters<typeof import("#preload/window.js").createWindowBridge>[0];
    nativeTheme: never;
  };
  const { windowAnswers } = await import("./window.js");
  const { KeptAppearance } = await import("../appearance/kept-record.js");
  const { AppearanceRecordFile } = await import("../appearance/record-file.js");
  const { createWindowBridge } = await import("#preload/window.js");
  const appearance = new KeptAppearance({
    file: new AppearanceRecordFile({
      filePath: appearanceFilePath,
      log: { write: vi.fn() },
    }),
    nativeTheme,
  });
  const openWindow = {
    setMinimumSize: (width: number, height: number) => {
      minimumSizes.push([width, height]);
    },
    getBounds: () => ({ x: 100, y: 100, width: 900, height: 600 }),
    isMinimized: () => true,
    restore: () => revealCalls.push("restore"),
    show: () => revealCalls.push("show"),
    showInactive: () => revealCalls.push("showInactive"),
    focus: () => revealCalls.push("focus"),
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
        endSafeStart: () => {
          safeStartEnds += 1;
        },
      },
    }),
  )) {
    ipcMain.handle(channel, answer as never);
  }
  return createWindowBridge(
    {
      invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
      on: (channel, listener) => pushListeners.set(channel, listener),
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
  revealCalls = [];
  isAskedFromTheConsole = true;
  safeStartEnds = 0;
  pushListeners = new Map();
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

  it("write no appearance file for an appearance the schema refuses", async () => {
    const windowBridge = await connectWindowBridge();

    await expect(
      windowBridge.setAppearance({ ...CHOICE, textSize: 17 } as never, GROUNDS),
    ).rejects.toThrow('"code": "invalid_value"');

    await expect(readFile(appearanceFilePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("set a named window's minimum size in whole pixels within its display, and no other's", async () => {
    const windowBridge = await connectWindowBridge();

    await windowBridge.setMinimumSize(OPEN_WINDOW_ID, { width: 640.2, height: 480 });
    // Past the display's work area on either side: held to it, so the window still fits.
    await windowBridge.setMinimumSize(OPEN_WINDOW_ID, { width: 3000, height: 2000 });
    // A window no open frame name carries.
    await expect(
      windowBridge.setMinimumSize("window/w-9", { width: 640, height: 480 }),
    ).rejects.toThrow("No open window has that id");

    expect(minimumSizes).toStrictEqual([
      [641, 480],
      [WORK_AREA.width, WORK_AREA.height],
    ]);
  });

  it("bring a named window forward through the reveal path, and nothing for a closed one", async () => {
    const windowBridge = await connectWindowBridge();

    await windowBridge.bringForward(OPEN_WINDOW_ID);
    await windowBridge.bringForward("window/w-9");

    expect(revealCalls).toStrictEqual(["restore", "show", "focus"]);
  });

  it("end a safe start, and hand the page main's ask to reopen a window", async () => {
    const windowBridge = await connectWindowBridge();
    const reopened: string[] = [];
    const stopHearing = windowBridge.subscribeToReopenRequest((windowId) =>
      reopened.push(windowId),
    );

    await windowBridge.endSafeStart();
    pushListeners.get(REOPEN_WINDOW_CHANNEL)?.({}, OPEN_WINDOW_ID);
    stopHearing();
    pushListeners.get(REOPEN_WINDOW_CHANNEL)?.({}, "window/w-9");

    expect(safeStartEnds).toBe(1);
    expect(reopened).toStrictEqual([OPEN_WINDOW_ID]);
  });

  it("answer no document but the console's, on every member", async () => {
    const windowBridge = await connectWindowBridge();
    isAskedFromTheConsole = false;
    const refusal = "Only the console document asks";

    await expect(windowBridge.setAppearance(CHOICE, GROUNDS)).rejects.toThrow(refusal);
    await expect(
      windowBridge.setMinimumSize(OPEN_WINDOW_ID, { width: 640, height: 480 }),
    ).rejects.toThrow(refusal);
    await expect(windowBridge.setDefaultSizes({ paneWidths: {} })).rejects.toThrow(refusal);
    await expect(windowBridge.endSafeStart()).rejects.toThrow(refusal);
    await expect(windowBridge.bringForward(OPEN_WINDOW_ID)).rejects.toThrow(refusal);
    const { ipcRenderer } = (await import("electron")) as unknown as {
      ipcRenderer: { invoke(channel: string): Promise<unknown> };
    };
    await expect(ipcRenderer.invoke(BRIDGE_CHANNELS.readAppearance)).rejects.toThrow(refusal);

    expect(safeStartEnds).toBe(0);
    expect(revealCalls).toStrictEqual([]);
    await expect(readFile(appearanceFilePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
