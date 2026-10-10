// macOS's selection keys: AppKit's standard key bindings, and the browser's page step there, which
// leaves a strip of the page in view. Select All is Command-A, and Home and End take a scroll view
// to its start and end (`scrollToBeginningOfDocument:`, `scrollToEndOfDocument:`), as do
// Command-Up and Command-Down, which AppKit binds to the document's start and end.

import type { SelectionKeys } from "./keys.js";

/** AppKit's standard key bindings for selecting and for a view's ends, and the page overlap. */
export const MAC_SELECTION_KEYS: SelectionKeys = {
  bindings: {
    ArrowLeft: { none: "character", alt: "word", meta: "lineboundary", ctrl: "lineboundary" },
    ArrowRight: { none: "character", alt: "word", meta: "lineboundary", ctrl: "lineboundary" },
    ArrowUp: { none: "line", alt: "paragraph", meta: "documentboundary" },
    ArrowDown: { none: "line", alt: "paragraph", meta: "documentboundary" },
    Home: { none: "documentboundary" },
    End: { none: "documentboundary" },
    PageUp: { none: "page" },
    PageDown: { none: "page" },
  },
  pageOverlapPx: 40,
  selectAll: [{ key: "a", modifier: "meta" }],
  jumps: {
    start: [
      { key: "Home", modifier: "none" },
      { key: "ArrowUp", modifier: "meta" },
    ],
    end: [
      { key: "End", modifier: "none" },
      { key: "ArrowDown", modifier: "meta" },
    ],
  },
};
