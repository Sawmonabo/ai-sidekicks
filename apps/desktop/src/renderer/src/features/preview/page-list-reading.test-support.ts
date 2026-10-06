// Page-list pages for the tab strip's suite, built in one place so a new `PreviewPage` member
// cannot be forgotten in one copy that still compiles.

import type { PreviewPage, PreviewPageId } from "@ai-sidekicks/contracts/preview/methods";

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
