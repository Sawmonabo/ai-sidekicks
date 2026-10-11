// The View menu's color scheme against main's appearance record: the tick follows the record, a
// pick moves it once written, a pick that is not kept puts the tick back on the scheme in force, is
// written to main's diagnostic log and is announced to the console document, and a change that
// keeps the scheme rebuilds nothing. About on each platform: the macOS app menu's roles, or the
// Help menu's one row elsewhere, and the panel filled from the running app before the menu is
// installed. The developer-tools row, only in a development build, on each platform's keys and
// toggling the tools of the window it was chosen in. `electron` is mocked; the kept appearance is
// real, over a file whose writes the case settles.

import { existsSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_APPEARANCE_RECORD,
  THEME_GROUNDS,
  type AppearanceRecord,
} from "#shared/appearance.js";
import { createElectronMock, type MenuTemplateItem } from "#test/helpers/electron/mock/module.js";

import type { MainDiagnosticEntry } from "./services/diagnostic-log.js";
import type { InstallLocation } from "./services/resource-file.js";

const electronMock = createElectronMock();

vi.mock("electron", () => electronMock.moduleExports);

beforeEach(() => {
  electronMock.reset();
});

/** A development checkout: this folder sits two below the package, as main's built entry does. */
const CHECKOUT: InstallLocation = {
  isPackaged: false,
  mainBundleFolder: import.meta.dirname,
  resourcesPath: "/unused-in-a-checkout",
};

const realPlatform = process.platform;

afterEach(async () => {
  Object.defineProperty(process, "platform", { value: realPlatform });
  vi.restoreAllMocks();
  const { app } = await import("electron");
  vi.mocked(app.getName).mockReset();
  vi.mocked(app.getVersion).mockReset();
});

/** An installed app's resources folder, on no machine, so only a path built from it matches. */
const INSTALLED_RESOURCES_FOLDER = "/sidekicks-installed-resources";

/**
 * Installs the menu on `platform`, from a development checkout unless `isPackaged`, the app
 * reporting a name and version no literal matches, and answers the About panel it filled, the
 * template it installed and the developer-tools toggle it was given.
 */
async function installOn(platform: NodeJS.Platform, isPackaged = false) {
  Object.defineProperty(process, "platform", { value: platform });
  const location: InstallLocation = isPackaged
    ? { ...CHECKOUT, isPackaged, resourcesPath: INSTALLED_RESOURCES_FOLDER }
    : CHECKOUT;
  const { app, Menu } = await import("electron");
  vi.mocked(app.getName).mockReturnValue("Sidekicks under test");
  vi.mocked(app.getVersion).mockReturnValue("9.9.9-test");
  const setAboutPanelOptions = vi.mocked(app.setAboutPanelOptions);
  const setApplicationMenu = vi.mocked(Menu.setApplicationMenu);
  setAboutPanelOptions.mockClear();
  setApplicationMenu.mockClear();
  const toggleDeveloperTools = vi.fn();
  const { installApplicationMenu } = await import("./menu.js");
  installApplicationMenu(
    { scheme: "system", chooseScheme: () => Promise.resolve(), subscribe: () => () => {} },
    { write: () => {} },
    { announceUnkeptScheme: () => {}, toggleDeveloperTools },
    location,
  );
  expect(setAboutPanelOptions).toHaveBeenCalledOnce();
  expect(setAboutPanelOptions.mock.invocationCallOrder[0]).toBeLessThan(
    setApplicationMenu.mock.invocationCallOrder[0] ?? 0,
  );
  const template = electronMock.installedMenuTemplates.at(-1) ?? [];
  return { panel: setAboutPanelOptions.mock.calls[0]?.[0], template, toggleDeveloperTools };
}

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
      { announceUnkeptScheme, toggleDeveloperTools: () => {} },
      CHECKOUT,
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
      THEME_GROUNDS.meridian,
    );
    writes[2]?.land();
    await textSizeKept;
    expect(appearance.record.textSize).toBe(20);
    expect(electronMock.installedMenuTemplates.length).toBe(installedBeforeTextSize);
  });
});

describe("About", () => {
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

    expect(panel?.iconPath).toBe(path.join(INSTALLED_RESOURCES_FOLDER, "icon.png"));
  });
});

describe("the developer tools row", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** Every row of `template`, all levels flattened. */
  function flattenRows(template: readonly MenuTemplateItem[]): MenuTemplateItem[] {
    const rows: MenuTemplateItem[] = [];
    const pending = [...template];
    for (let row = pending.pop(); row !== undefined; row = pending.pop()) {
      rows.push(row);
      pending.push(...(row.submenu ?? []));
    }
    return rows;
  }

  it.each([
    ["darwin", "Alt+Command+J"],
    ["win32", "Control+Shift+J"],
    ["linux", "Control+Shift+J"],
  ] as const)(
    "on %s holds %s and toggles the tools of the window it was chosen in",
    async (platform, accelerator) => {
      const { template, toggleDeveloperTools } = await installOn(platform);
      const rows = flattenRows(template);

      const row = rows.find((candidate) => candidate.label === "Toggle Developer Tools");
      expect(row?.accelerator).toBe(accelerator);
      expect(rows.some((candidate) => candidate.accelerator === "F12")).toBe(false);
      expect(rows.some((candidate) => candidate.role === "toggleDevTools")).toBe(false);
      const chosenWindow = { id: 7 };
      row?.click?.(row, chosenWindow);
      expect(toggleDeveloperTools).toHaveBeenCalledExactlyOnceWith(chosenWindow);
    },
  );

  it("is absent outside a development build", async () => {
    vi.stubEnv("DEV", false);
    const rows = flattenRows((await installOn("darwin")).template);

    expect(rows.some((candidate) => candidate.label === "Toggle Developer Tools")).toBe(false);
    expect(rows.some((candidate) => candidate.role === "toggleDevTools")).toBe(false);
  });
});
