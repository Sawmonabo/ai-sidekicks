// The selection keys on Windows and Linux: the browser's own key table, and its page step there,
// which only its share of the page bounds.

import type { SelectionKeys } from "./keys.js";

/** The browser's key table for extending a selection on Windows and Linux. */
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
};
