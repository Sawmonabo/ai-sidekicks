// What the pane KNOWS about the session's pages, as opposed to what the strip draws.
//
// The strip shows one tab per page this session owns, and every page it owns. Which page
// is active and whether a page is loading are both read off the frame the pane's content
// is handed, never inferred from the last act dispatched.
//
// It is a second reading beside the navigation one and not an arm of it. The navigation
// reading answers "where is the page this pane is showing"; this one answers "what pages
// does this session own". A pane showing nothing still owns pages, and a pane showing a
// page whose list has not arrived still has a URL to render.

import type { PreviewPage, PreviewPageListFrame } from "@ai-sidekicks/contracts";

import type { ReadingState } from "../../primitives/index.js";

/** One page the session owns, as every surface in this family reads it. */
export type BrowserPage = PreviewPage;

/**
 * What the pane knows about the session's pages right now.
 *
 * The same arms `navigation-state.ts` declares and for the same reason: an ended
 * subscription is a fact, and it carries no last frame, because a strip drawing tabs
 * nobody reports any more would offer close controls over pages that may be gone.
 */
export type PageListReading =
  | Extract<ReadingState, { readonly kind: "reading" }>
  | (Extract<ReadingState, { readonly kind: "served" }> & { readonly frame: PreviewPageListFrame })
  | { readonly kind: "ended" };

/**
 * The pages a served reading carries, and nothing on any other arm.
 *
 * A helper rather than a ternary at each call site, because the empty array is the
 * same value for "this session owns no pages" and "nobody has answered yet"; callers
 * that need to tell them apart branch on the reading itself.
 */
export function pagesOf(reading: PageListReading): readonly BrowserPage[] {
  return reading.kind === "served" ? reading.frame.pages : [];
}

/**
 * The page the pane is showing: the served frame's page at its active index, and
 * `undefined` on any other arm or when the session has no page open.
 */
export function activePageOf(reading: PageListReading): BrowserPage | undefined {
  return reading.kind === "served" ? reading.frame.pages[reading.frame.activeIndex] : undefined;
}
