// Page-list readings a suite can hand a strip, built once.
//
// Two suites drive the tab strip over the same three pages — the co-located unit
// suite, which owns the readings and the drop arithmetic, and the browser tier, which
// owns what only a real `DataTransfer` and a real cascade can settle. Written twice
// the two would drift the first time `PreviewPage` grows a member, and the copy that
// forgot it would still compile: every field here has a default, so an omission reads
// as a deliberate choice rather than as a gap.

import type { PreviewPage, PreviewPageId } from "@ai-sidekicks/contracts";

import type { PageListReading } from "./page-list-reading.js";

/** One page, defaulted so a case names only the field it is about. */
export function previewPage(
  overrides: Omit<Partial<PreviewPage>, "pageId"> & { readonly pageId: string },
): PreviewPage {
  return {
    title: `Title ${overrides.pageId}`,
    address: `https://example.test/${overrides.pageId}`,
    host: "example.test",
    favicon: null,
    loadState: { kind: "loaded" },
    backDepth: 0,
    forwardDepth: 0,
    zoomFactor: 1,
    released: false,
    ...overrides,
    pageId: overrides.pageId as PreviewPageId,
  };
}

/**
 * Three drawn pages, the first of them active.
 *
 * A FUNCTION and not a shared constant: a reading handed to two mounts in one file
 * would be one object two components hold, and a case that reached into it would
 * change what the next case renders.
 */
export function threePreviewPages(): PageListReading {
  return {
    kind: "served",
    frame: {
      pages: [
        previewPage({ pageId: "page-a" }),
        previewPage({ pageId: "page-b" }),
        previewPage({ pageId: "page-c" }),
      ],
      activeIndex: 0,
    },
  };
}
