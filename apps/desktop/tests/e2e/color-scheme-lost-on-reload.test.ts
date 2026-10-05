// The color scheme lives in one place, main's appearance record, and every surface agrees with it.
// A pick from the palette is written to `appearance.json` before the page shows it, survives a
// reload of the console document because main stamps the record on the document it serves and the
// reloaded console draws its window from it, and a pick from the View menu changes the open window
// and moves the menu's tick, so the menu and the page never disagree.

import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { APPEARANCE_FILE_NAME } from "@main/appearance/record-file.js";
import { withLaunchedApp, type AppUnderTest } from "../helpers/electron-harness.js";
import { clickViewMenuScheme, readPageScheme } from "./color-scheme.js";
import { openPalette } from "../helpers/palette-interaction.js";
import { fixtureBundleExists } from "../helpers/fixture-bundle.js";
import { IN_WINDOW_STEP_TIMEOUT_MS } from "../helpers/launch-body.js";
import { READINESS_BUDGET_MS } from "../helpers/launch-budgets.js";
import { LaunchDeadline } from "../helpers/launch-deadline.js";

const bundleIsBuilt = fixtureBundleExists();

/** The scheme main's record holds on disk, read in this process from main's own folder. */
async function readKeptScheme(appUnderTest: AppUnderTest): Promise<unknown> {
  const userData = await appUnderTest.application.evaluate(({ app }) => app.getPath("userData"));
  const recordText = await readFile(path.join(userData, APPEARANCE_FILE_NAME), "utf8");
  return (JSON.parse(recordText) as { readonly scheme?: unknown }).scheme;
}

/** The View menu's scheme rows, label and tick, as main installed them. */
async function readMenuTicks(appUnderTest: AppUnderTest): Promise<Record<string, boolean>> {
  return await appUnderTest.application.evaluate(({ Menu }) => {
    const view = Menu.getApplicationMenu()?.items.find((item) => item.label === "View");
    const rows = (view?.submenu?.items ?? []).filter((item) => item.type === "radio");
    return Object.fromEntries(rows.map((row) => [row.label, row.checked]));
  });
}

describe.skipIf(!bundleIsBuilt)("end-to-end — the color scheme is main's record", () => {
  it("keeps a palette pick across a reload, and a View-menu pick reaches the open window", async () => {
    await withLaunchedApp({}, async (appUnderTest) => {
      const stepTimeout = (): number =>
        appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS);

      // A fresh profile follows the system: no attribute, so the sheet's `prefers-color-scheme`
      // layer keeps following the OS; a resolved value here would be the defect.
      expect(await readPageScheme(appUnderTest.window)).toBeNull();

      // Through the palette, the whole path a person takes: the `Color scheme` row moves to the
      // next scheme in its cycle, and the one after "system" is dark.
      await openPalette(appUnderTest);
      await appUnderTest.window.keyboard.type("Color scheme");
      await appUnderTest.window.keyboard.press("Enter");
      await expect
        .poll(async () => await readPageScheme(appUnderTest.window), {
          timeout: stepTimeout(),
          message: "the scheme did not change",
        })
        .toBe("dark");
      // Main writes before it tells the page, so the page showing it means the record holds it.
      expect(await readKeptScheme(appUnderTest)).toBe("dark");

      // The reload boots the renderer a second time, which `launch-readiness` bounds, so the
      // navigation, the window the new console document opens and its frame element share one
      // clock at that figure. Every leg is also held to what is left of the body's allowance.
      const reloadDeadline = new LaunchDeadline(READINESS_BUDGET_MS);
      // Armed before the reload: main closes the old window as the document goes, and the new
      // console document opens the one drawn next.
      const reopened = appUnderTest.application.waitForEvent("window", {
        timeout: appUnderTest.bodyAllowance.boundedMs(reloadDeadline.remainingMs()),
      });
      await appUnderTest.consolePage.reload({
        timeout: appUnderTest.bodyAllowance.boundedMs(reloadDeadline.remainingMs()),
      });
      const reopenedWindow = await reopened;
      await reopenedWindow.waitForSelector(".meridian-frame", {
        timeout: appUnderTest.bodyAllowance.boundedMs(reloadDeadline.remainingMs()),
      });
      expect(await readPageScheme(reopenedWindow), "the scheme did not survive a reload").toBe(
        "dark",
      );

      // The View menu's row, clicked in main as a person's click runs it.
      const isClicked = await clickViewMenuScheme(appUnderTest, "Light");
      expect(isClicked, "the View menu has a Light row").toBe(true);
      await expect
        .poll(async () => await readPageScheme(reopenedWindow), {
          timeout: stepTimeout(),
          message: "the View menu's pick did not reach the open window",
        })
        .toBe("light");
      expect(await readKeptScheme(appUnderTest)).toBe("light");
      expect(await readMenuTicks(appUnderTest)).toStrictEqual({
        System: false,
        Light: true,
        Dark: false,
      });
    });
  });
});
