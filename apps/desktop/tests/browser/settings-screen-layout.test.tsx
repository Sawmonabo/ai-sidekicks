// The browser tier: how the settings screen shares a window's width, which only a real engine's
// grid and resize observers decide. The list's track is as wide as its longest page name and
// stays that wide while a term is typed; when the page's content and the list no longer fit
// side by side the screen shows one pane at a time, handing focus to the pane that took over, and
// a change of text size is weighed again.

import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { installMeridianTokens } from "#renderer/app/token-installation.js";
import {
  renderRoutedSettingsScreen,
  windowAt,
} from "#renderer/features/settings/SettingsScreen.test-support.js";
import { SettingsPageRegistry } from "#renderer/features/settings/pages/registry.js";
import { changeLayout } from "#test/helpers/animation-frame.js";
// Imported for its side effect: the settings chunk root imports the sheets measured here.
import "#renderer/features/settings/screen-body.js";

/** The width of the test page's own content, so the break has a known place. */
const PAGE_CONTENT_WIDTH_REM = 30;

afterEach(() => {
  cleanup();
});

/** One page, drawing content exactly as wide as the case says. */
function pagesWithKnownWidth(): SettingsPageRegistry {
  const pages = new SettingsPageRegistry();
  pages.register({
    pageId: "keyboard",
    keywords: [],
    note: "",
    render: () => <div style={{ inlineSize: `${String(PAGE_CONTENT_WIDTH_REM)}rem` }} />,
  });
  return pages;
}

function elementIn(container: HTMLElement, selector: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(selector);
  if (element === null) {
    throw new Error(`the screen drew no ${selector}`);
  }
  return element;
}

describe("browser — the settings screen shares the window's width", () => {
  it("keeps the list's width while searching, and shows one pane at a time below the content width", async () => {
    installMeridianTokens(document);
    const settingsWindow = windowAt("keyboard");
    const { container, getByRole } = await renderRoutedSettingsScreen(
      settingsWindow,
      pagesWithKnownWidth(),
    );
    await changeLayout(() => {
      container.style.inlineSize = "100rem";
    });
    const screen = elementIn(container, ".meridian-settings");
    const listPane = elementIn(container, ".meridian-settings__list-pane");
    const pagePane = elementIn(container, ".meridian-settings__pane");
    await waitFor(() => {
      expect(screen.dataset["arrangement"]).toBe("side-by-side");
    });

    // The track is sized by the page names, so neither hits nor the no-match line narrow it.
    const listWidth = listPane.getBoundingClientRect().width;
    const searchField = getByRole("combobox", { name: "Search settings" });
    for (const term of ["Keyboard", "zzzz"]) {
      fireEvent.change(searchField, { target: { value: term } });
      expect(listPane.getBoundingClientRect().width, `while "${term}" is typed`).toBe(listWidth);
    }
    fireEvent.change(searchField, { target: { value: "" } });

    // Side by side needs the list, the page's content and the page pane's gutters.
    const pageGutters =
      Number.parseFloat(getComputedStyle(pagePane).paddingInlineStart) +
      Number.parseFloat(getComputedStyle(pagePane).paddingInlineEnd);
    const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    const neededWidth = listWidth + PAGE_CONTENT_WIDTH_REM * rootFontSize + pageGutters;
    await changeLayout(() => {
      container.style.inlineSize = `${String(Math.ceil(neededWidth) + 1)}px`;
    });
    await waitFor(() => {
      expect(screen.dataset["arrangement"]).toBe("side-by-side");
    });
    await changeLayout(() => {
      container.style.inlineSize = `${String(Math.floor(neededWidth) - rootFontSize)}px`;
    });
    await waitFor(() => {
      expect(screen.dataset["arrangement"]).toBe("one-at-a-time");
    });
    expect([listPane.hidden, pagePane.hidden]).toStrictEqual([true, false]);

    // Back to the list: its tab stop is the page just left, and focus is handed to it.
    act(() => {
      getByRole("button", { name: "Back to the Settings pages" }).click();
    });
    expect([listPane.hidden, pagePane.hidden]).toStrictEqual([false, true]);
    const keyboardEntry = getByRole("button", { name: "Keyboard" });
    expect(keyboardEntry.tabIndex).toBe(0);
    expect(document.activeElement).toBe(keyboardEntry);

    // Into the page again: its heading takes focus from the hidden list.
    act(() => {
      keyboardEntry.click();
    });
    await waitFor(() => {
      expect([listPane.hidden, pagePane.hidden]).toStrictEqual([true, false]);
    });
    expect(document.activeElement).toBe(getByRole("heading", { name: "Keyboard" }));

    // A smaller text size shrinks the page's content, so the two fit side by side again.
    try {
      await changeLayout(() => {
        document.documentElement.style.fontSize = `${String(rootFontSize / 2)}px`;
      });
      await waitFor(() => {
        expect(screen.dataset["arrangement"]).toBe("side-by-side");
      });
    } finally {
      await changeLayout(() => {
        document.documentElement.style.removeProperty("font-size");
      });
    }
  });
});
