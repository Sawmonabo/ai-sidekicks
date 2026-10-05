// The pages this session owns, as opposed to what the strip draws. A second reading beside the
// navigation one: a pane showing nothing still owns pages, and a pane whose list has not arrived
// still has a URL to render. Active page and loading state come off the served frame.

import type { PreviewPage, PreviewPageListFrame } from "@ai-sidekicks/contracts/preview/preview";

import type { ReadingState } from "@renderer/lib/partial-read.js";

/**
 * What the pane knows about the session's pages right now. Like `NavigationReading`, an ended
 * subscription carries no last frame, so the strip never offers close controls over gone pages.
 */
export type PageListReading =
  | Extract<ReadingState, { readonly kind: "reading" }>
  | (Extract<ReadingState, { readonly kind: "served" }> & { readonly frame: PreviewPageListFrame })
  | { readonly kind: "ended" };

/**
 * The pages a served reading carries, else none. An empty array means both "owns no pages" and
 * "nobody has answered yet"; a caller that must tell them apart branches on the reading.
 */
export function pagesOf(reading: PageListReading): readonly PreviewPage[] {
  return reading.kind === "served" ? reading.frame.pages : [];
}

/** The page at the served frame's active index, or `undefined` on any other arm or no page. */
export function activePageOf(reading: PageListReading): PreviewPage | undefined {
  return reading.kind === "served" ? reading.frame.pages[reading.frame.activeIndex] : undefined;
}
