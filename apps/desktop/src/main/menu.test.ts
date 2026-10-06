// The View menu's color scheme against main's appearance record: the tick follows the record, a
// pick moves it once written, a pick that is not kept puts the tick back on the scheme in force, is
// written to main's diagnostic log and is announced to the console document, and a change that
// keeps the scheme rebuilds nothing. About on each platform: the macOS app menu's roles, or the
// Help menu's one row elsewhere, and the panel filled from the running app before the menu is
// installed. `electron` is mocked; the kept appearance is real, over a file whose writes the case
// settles.

import { existsSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_APPEARANCE_RECORD,
  MERIDIAN_GROUNDS,
  type AppearanceRecord,
} from "#shared/appearance.js";
import { createElectronMock, type MenuTemplateItem } from "#test/helpers/electron/mock/module.js";

import type { MainDiagnosticEntry } from "./services/diagnostic-log.js";

const electronMock = createElectronMock();

vi.mock("electron", () => electronMock.moduleExports);

beforeEach(() => {
  electronMock.reset();
});

const realPlatform = process.platform;

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform });
  vi.restoreAllMocks();
});

/** The View menu's scheme rows in the menu installed last, by label. */
function installedSchemeRows(): readonly MenuTemplateItem[] {
  const view = electronMock.installedMenuTemplates.at(-1)?.find((item) => item.label === "View");
  return (view?.submenu ?? []).filter((item) => item.type === "radio");
}

/** The label of the row ticked in the menu installed last. */
function tickedScheme(): string | undefined {
  return installedSchemeRows().find((row) => row.checked === true)?.label;
}

/** Clicks the scheme row labeled `label` in the menu installed last. */
function clickScheme(label: string): void {
  const row = installedSchemeRows().find((candidate) => candidate.label === label);
  (row?.click ?? expect.fail(`the View menu has a ${label} row`))();
}

describe("the View menu's color scheme", () => {
  it("moves its tick once a pick is written, and puts it back, logged and announced, when one is not", async () => {
    const { KeptAppearance } = await import("./appearance/kept-record.js");
    const { installApplicationMenu } = await import("./menu.js");
    const writes: { land: () => void; fail: (failure: Error) => void }[] = [];
    const appearance = new KeptAppearance({
      file: {
        readSync: () => DEFAULT_APPEARANCE_RECORD,
        write: (_record: AppearanceRecord) =>
          new Promise<void>((resolve, reject) => {
            writes.push({ land: resolve, fail: reject });
          }),
      },
      nativeTheme: electronMock.nativeTheme as never,
    });
    const logged: MainDiagnosticEntry[] = [];
    const announceUnkeptScheme = vi.fn();
    installApplicationMenu(
      appearance,
      { write: (entry) => logged.push(entry) },
      { announceUnkeptScheme },
    );
    expect(tickedScheme()).toBe("System");

    clickScheme("Dark");
    writes[0]?.land();
    await vi.waitFor(() => {
      expect(tickedScheme()).toBe("Dark");
    });
    expect(announceUnkeptScheme).not.toHaveBeenCalled();

    const installedBefore = electronMock.installedMenuTemplates.length;
    clickScheme("Light");
    writes[1]?.fail(new Error("no space left on device"));
    await vi.waitFor(() => {
      expect(electronMock.installedMenuTemplates.length).toBe(installedBefore + 1);
    });

    expect(tickedScheme()).toBe("Dark");
    expect(appearance.scheme).toBe("dark");
    expect(logged).toMatchObject([
      { level: "error", source: "main/menu", message: expect.stringContaining("no space left") },
    ]);
    expect(announceUnkeptScheme).toHaveBeenCalledOnce();

    const installedBeforeTextSize = electronMock.installedMenuTemplates.length;
    const textSizeKept = appearance.choose(
      { theme: "meridian", scheme: "dark", textSize: 20, transcriptWidth: 57.5 },
      MERIDIAN_GROUNDS,
    );
    writes[2]?.land();
    await textSizeKept;
    expect(appearance.record.textSize).toBe(20);
    expect(electronMock.installedMenuTemplates.length).toBe(installedBeforeTextSize);
  });
});

describe("About", () => {
  /** An installed app's resources folder, on no machine, so only a path built from it matches. */
  const installedResourcesFolder = "/sidekicks-installed-resources";
  /** The resources folder the Electron mock gave the process, put back after each test. */
  const mockResourcesPath = process.resourcesPath;

  afterEach(async () => {
    const { app } = await import("electron");
    vi.mocked(app.getName).mockReset();
    vi.mocked(app.getVersion).mockReset();
    Object.defineProperty(process, "resourcesPath", {
      value: mockResourcesPath,
      configurable: true,
    });
  });

  /**
   * Installs the menu on `platform`, from a development checkout unless `isPackaged`, the app
   * reporting a name and version no literal matches.
   */
  async function installOn(platform: NodeJS.Platform, isPackaged = false) {
    Object.defineProperty(process, "platform", { value: platform });
    electronMock.setPackaged(isPackaged);
    if (isPackaged) {
      Object.defineProperty(process, "resourcesPath", {
        value: installedResourcesFolder,
        configurable: true,
      });
    }
    const { app, Menu } = await import("electron");
    vi.mocked(app.getName).mockReturnValue("Sidekicks under test");
    vi.mocked(app.getVersion).mockReturnValue("9.9.9-test");
    const setAboutPanelOptions = vi.mocked(app.setAboutPanelOptions);
    const setApplicationMenu = vi.mocked(Menu.setApplicationMenu);
    setAboutPanelOptions.mockClear();
    setApplicationMenu.mockClear();
    const { installApplicationMenu } = await import("./menu.js");
    installApplicationMenu(
      { scheme: "system", chooseScheme: () => Promise.resolve(), subscribe: () => () => {} },
      { write: () => {} },
      { announceUnkeptScheme: () => {} },
    );
    expect(setAboutPanelOptions).toHaveBeenCalledOnce();
    expect(setAboutPanelOptions.mock.invocationCallOrder[0]).toBeLessThan(
      setApplicationMenu.mock.invocationCallOrder[0] ?? 0,
    );
    const template = electronMock.installedMenuTemplates.at(-1) ?? [];
    return { panel: setAboutPanelOptions.mock.calls[0]?.[0], template };
  }

  it("on macOS opens with the app menu's own roles, the bundle supplying the icon", async () => {
    const { panel, template } = await installOn("darwin");

    expect(template[0]?.role).toBe("appMenu");
    expect(template[0]?.submenu?.flatMap((item) => item.role ?? [])).toEqual([
      "about",
      "hide",
      "hideOthers",
      "unhide",
      "quit",
    ]);
    expect(template.some((item) => item.role === "help")).toBe(false);
    expect(panel).toEqual({
      applicationName: "Sidekicks under test",
      applicationVersion: "9.9.9-test",
      version: "9.9.9-test",
    });
  });

  it.each(["win32", "linux"] as const)(
    "on %s ends with Help's one About row, the panel showing the checkout's app icon",
    async (platform) => {
      const { panel, template } = await installOn(platform);

      expect(template.some((item) => item.role === "appMenu")).toBe(false);
      expect(template.at(-1)?.role).toBe("help");
      expect(template.at(-1)?.submenu).toEqual([
        { role: "about", label: "About Sidekicks under test" },
      ]);
      expect(panel).toEqual({
        applicationName: "Sidekicks under test",
        applicationVersion: "9.9.9-test",
        iconPath: expect.stringMatching(/icon\.png$/u),
      });
      expect(existsSync(panel?.iconPath ?? "")).toBe(true);
    },
  );

  it("in an installed app takes the icon from beside its archive", async () => {
    const { panel } = await installOn("linux", true);

    expect(panel?.iconPath).toBe(path.join(installedResourcesFolder, "icon.png"));
  });
});
