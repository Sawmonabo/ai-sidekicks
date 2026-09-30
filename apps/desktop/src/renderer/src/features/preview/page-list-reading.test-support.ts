// Page-list readings shared by the tab strip's unit suite and its browser tier, so a new
// `PreviewPage` member cannot be forgotten in one copy that still compiles.

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
 * Three drawn pages, the first active. A function, not a constant: a reading shared by two
 * mounts would be one object that a case could mutate under the next.
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
