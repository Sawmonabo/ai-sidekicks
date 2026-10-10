// Reading and picking the color scheme from outside the app, for the end-to-end tests: the scheme
// a window's root carries, the View menu's ticks, and a View-menu row clicked in main as a
// person's click runs it.

import type { Page } from "playwright";

import { SCHEME_ATTRIBUTE } from "#shared/appearance.js";
import type { AppUnderTest } from "../../helpers/electron/harness.js";

/** The scheme a window's root carries: `null` under `system`, which writes no attribute. */
export async function readPageScheme(appWindow: Page): Promise<string | null> {
  return await appWindow.evaluate(
    (schemeAttribute) => document.documentElement.getAttribute(schemeAttribute),
    SCHEME_ATTRIBUTE,
  );
}

/** Clicks the View menu's scheme row labeled `label` in main; false when the menu has none. */
export async function clickViewMenuScheme(
  appUnderTest: AppUnderTest,
  label: string,
): Promise<boolean> {
  return await appUnderTest.application.evaluate(({ Menu }, rowLabel) => {
    const view = Menu.getApplicationMenu()?.items.find((item) => item.label === "View");
    const row = view?.submenu?.items.find((item) => item.label === rowLabel);
    row?.click();
    return row !== undefined;
  }, label);
}

/** The View menu's scheme rows, label and tick, as main installed them. */
export async function readMenuTicks(appUnderTest: AppUnderTest): Promise<Record<string, boolean>> {
  return await appUnderTest.application.evaluate(({ Menu }) => {
    const view = Menu.getApplicationMenu()?.items.find((item) => item.label === "View");
    const rows = (view?.submenu?.items ?? []).filter((item) => item.type === "radio");
    return Object.fromEntries(rows.map((row) => [row.label, row.checked]));
  });
}
