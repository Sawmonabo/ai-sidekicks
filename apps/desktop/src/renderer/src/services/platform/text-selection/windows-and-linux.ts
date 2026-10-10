// The selection keys on Windows and Linux: the browser's own key table, and its page step there,
// which only its share of the page bounds. Select All is Control-A, and Home and End take a scroll
// view to its start and end, with Control or without, as the browser's own scroll keys do.

import type { SelectionKeys } from "./keys.js";

/** The browser's key table for selecting and for a view's ends on Windows and Linux. */
export const WINDOWS_AND_LINUX_SELECTION_KEYS: SelectionKeys = {
  bindings: {
    ArrowLeft: { none: "character", ctrl: "word" },
    ArrowRight: { none: "character", ctrl: "word" },
    ArrowUp: { none: "line", ctrl: "paragraph" },
    ArrowDown: { none: "line", ctrl: "paragraph" },
    Home: { none: "lineboundary", ctrl: "documentboundary" },
    End: { none: "lineboundary", ctrl: "documentboundary" },
    PageUp: { none: "page" },
    PageDown: { none: "page" },
  },
  pageOverlapPx: Infinity,
  selectAll: [{ key: "a", modifier: "ctrl" }],
  jumps: {
    start: [
      { key: "Home", modifier: "none" },
      { key: "Home", modifier: "ctrl" },
    ],
    end: [
      { key: "End", modifier: "none" },
      { key: "End", modifier: "ctrl" },
    ],
  },
};
