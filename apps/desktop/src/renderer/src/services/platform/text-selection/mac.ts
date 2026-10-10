// macOS's selection keys: AppKit's standard key bindings, and the browser's page step there, which
// leaves a strip of the page in view.

import type { SelectionKeys } from "./keys.js";

/** AppKit's standard key bindings for extending a selection, and the page step's overlap. */
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
};
