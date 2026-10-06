// The View menu's color scheme against main's appearance record: the tick follows the record, a
// pick moves it once written, and a pick that is not kept puts the tick back on the scheme in force
// and is written to main's diagnostic log. `electron` is mocked; the kept appearance is real, over
// a file whose writes the case settles.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_APPEARANCE_RECORD, type AppearanceRecord } from "#shared/appearance.js";
import { createElectronMock, type MenuTemplateItem } from "#test/helpers/electron/mock/module.js";

import type { MainDiagnosticEntry } from "./services/diagnostic-log.js";

const electronMock = createElectronMock();

vi.mock("electron", () => electronMock.moduleExports);

beforeEach(() => {
  electronMock.reset();
});

afterEach(() => {
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
  it("moves its tick once a pick is written, and puts it back, logged, when one is not", async () => {
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
    installApplicationMenu(appearance, {
      log: { write: (entry) => logged.push(entry) },
      now: () => new Date("2026-10-05T09:00:00.000Z"),
    });
    expect(tickedScheme()).toBe("System");

    clickScheme("Dark");
    writes[0]?.land();
    await vi.waitFor(() => {
      expect(tickedScheme()).toBe("Dark");
    });

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
  });
});
