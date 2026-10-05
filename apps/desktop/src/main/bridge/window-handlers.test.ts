// The `window` members end to end, from the preload's object through Electron's IPC (mocked, with
// its structured cloning) to main's answers: a chosen appearance is kept and comes back as the
// first delivery of a subscription, and a request the schema refuses changes nothing.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppearanceRecord } from "@shared/appearance.js";
import { createElectronMock } from "@test/helpers/electron-mock.js";

const electronMock = createElectronMock();

vi.mock("electron", () => electronMock.moduleExports);

const CHOICE = { theme: "meridian", scheme: "light", textSize: 18, transcriptWidth: 42 } as const;
const GROUNDS = { light: "#fbfaf7", dark: "#141516" } as const;
/** The work area of the one display the asking window is on. */
const WORK_AREA = { x: 0, y: 25, width: 1440, height: 875 };

let userData: string;
let appearanceFilePath: string;
let minimumSizes: [number, number][];

/** The preload's `window` member over the mocked IPC, answered by main's real handlers. */
async function connectWindowBridge() {
  vi.resetModules();
  const { ipcMain, ipcRenderer, nativeTheme } = (await import("electron")) as unknown as {
    ipcMain: { handle(channel: string, answer: (...args: never[]) => unknown): void };
    ipcRenderer: Parameters<typeof import("@preload/window-bridge.js").createWindowBridge>[0];
    nativeTheme: never;
  };
  const { windowAnswers } = await import("./window-handlers.js");
  const { KeptAppearance } = await import("../appearance/kept-appearance.js");
  const { AppearanceRecordFile } = await import("../appearance/record-file.js");
  const { createWindowBridge } = await import("@preload/window-bridge.js");
  const appearance = new KeptAppearance({
    file: new AppearanceRecordFile({
      filePath: appearanceFilePath,
      log: { write: vi.fn() },
      now: () => new Date(),
    }),
    nativeTheme,
  });
  const senderWindow = {
    setMinimumSize: (width: number, height: number) => {
      minimumSizes.push([width, height]);
    },
    getBounds: () => ({ x: 100, y: 100, width: 900, height: 600 }),
    isFullScreen: () => false,
  };
  for (const [channel, answer] of Object.entries(
    windowAnswers({
      appearance,
      openWindows: { windowShowing: () => senderWindow as never },
    }),
  )) {
    ipcMain.handle(channel, answer as never);
  }
  return createWindowBridge(ipcRenderer, "w-1");
}

beforeEach(async () => {
  electronMock.reset();
  electronMock.setDisplayWorkAreas([WORK_AREA]);
  userData = await mkdtemp(path.join(tmpdir(), "sidekicks-window-bridge-test-"));
  appearanceFilePath = path.join(userData, "appearance.json");
  minimumSizes = [];
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

  it("set the asking window's minimum size in whole pixels within its display, refusing a non-size", async () => {
    const windowBridge = await connectWindowBridge();

    await windowBridge.setMinimumSize({ width: 640.2, height: 480 });
    // Past the display's work area on either side: held to it, so the window still fits.
    await windowBridge.setMinimumSize({ width: 3000, height: 2000 });
    await expect(windowBridge.setMinimumSize({ width: 0, height: 480 })).rejects.toThrow();
    await expect(windowBridge.setMinimumSize({ width: Number.NaN, height: 480 })).rejects.toThrow();

    expect(minimumSizes).toStrictEqual([
      [641, 480],
      [WORK_AREA.width, WORK_AREA.height],
    ]);
  });
});
