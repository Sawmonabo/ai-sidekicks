// One pane at a time, opening a page hides the list and `‹ Settings` hides the page, so whatever
// held focus is hidden with it and focus would fall to the document. The pane taking its place
// takes focus instead: a page its heading, the list its open entry. Side by side nothing hides,
// so nothing moves.

import { useLayoutEffect, useRef } from "react";

/** Which of the two panes the screen shows. */
export type SettingsShownPane = "both" | "list" | "page";

/** The two panes and which of them shows. */
export interface FocusShownPaneOptions {
  readonly listPane: HTMLElement | null;
  readonly pagePane: HTMLElement | null;
  readonly shownPane: SettingsShownPane;
}

/** Move focus into the pane that took the screen when the focused one was hidden. */
export function useFocusShownPane(options: FocusShownPaneOptions): void {
  const { listPane, pagePane, shownPane } = options;
  const previousShownPane = useRef(shownPane);
  useLayoutEffect(() => {
    const wasShown = previousShownPane.current;
    previousShownPane.current = shownPane;
    if (shownPane === wasShown || shownPane === "both" || listPane === null || pagePane === null) {
      return;
    }
    const [shown, hidden] = shownPane === "page" ? [pagePane, listPane] : [listPane, pagePane];
    const focused = shown.ownerDocument.activeElement;
    // Focus outside Settings, on the window's navigation rail say, is the person's to keep.
    if (focused !== null && focused !== shown.ownerDocument.body && !hidden.contains(focused)) {
      return;
    }
    const preferredTargets = shownPane === "page" ? PAGE_FOCUS_SELECTORS : LIST_FOCUS_SELECTORS;
    for (const selector of preferredTargets) {
      const target = shown.querySelector<HTMLElement>(selector);
      if (target !== null) {
        target.focus();
        return;
      }
    }
  }, [listPane, pagePane, shownPane]);
}

/** Where a page takes focus, in preference: its heading, else `‹ Settings` above no page. */
const PAGE_FOCUS_SELECTORS = [".meridian-settings__page-heading", ".meridian-settings__back"];

/** Where the list takes focus, in preference: its one tab stop, else the search box above hits. */
const LIST_FOCUS_SELECTORS = ['.meridian-settings__page-entry[tabindex="0"]', "input"];
