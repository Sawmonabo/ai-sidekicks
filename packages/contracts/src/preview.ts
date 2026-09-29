// The Preview pane's pages: what the daemon reports about each page a session
// owns, how a client reorders them, and the keystroke the main process hands back
// when a page claims one of the console's chords.
//
// The daemon owns every page and mints every page id; the renderer owns none. It
// reads the list, sends requests keyed by session and page, and main keeps one
// native view per page in step with the list.
import { z } from "zod";

import { SessionIdSchema, type SessionId } from "./session.js";

/**
 * One open page in a session's Preview pane.
 *
 * `title` is the page's own title and may be empty; a surface that labels the page
 * shows `host` in its place, so the host is carried rather than re-parsed from the
 * address at every call site. `label` is `null` where no agent named the page, and
 * a surface shows the label where there is one and the title otherwise.
 *
 * `backDepth` and `forwardDepth` are how far the page's history reaches either way:
 * the back and forward controls act when theirs is above zero.
 *
 * `loadProgress` is required and nullable. `null` means the engine reports no
 * fraction while loading, so the surface draws an indeterminate bar; an optional
 * member would read as "not answered yet" instead.
 */
export interface PreviewPage {
  pageId: string;
  address: string;
  host: string;
  title: string;
  label: string | null;
  isLoading: boolean;
  loadProgress: number | null;
  backDepth: number;
  forwardDepth: number;
}

/** The session whose pages a `preview.pageList` subscription streams. */
export interface PreviewPageListRequest {
  sessionId: SessionId;
}
/** Parses a {@link PreviewPageListRequest}. */
export const PreviewPageListRequestSchema: z.ZodType<
  PreviewPageListRequest,
  PreviewPageListRequest
> = z.object({ sessionId: SessionIdSchema }).strict();

/**
 * One frame of a session's page list: every page in the session's order, and the
 * index of the one the pane shows, `-1` where the session has no page open.
 */
export interface PreviewPageListFrame {
  pages: PreviewPage[];
  activeIndex: number;
}

/**
 * Move one page within its session's order.
 *
 * `toIndex` is a position in the list WITHOUT that page in it. The surface that
 * drags a tab counts drop slots among the tabs as drawn and translates once, where
 * it sends the request.
 */
export interface PreviewPageReorderRequest {
  sessionId: SessionId;
  pageId: string;
  toIndex: number;
}
/** Parses a {@link PreviewPageReorderRequest}. */
export const PreviewPageReorderRequestSchema: z.ZodType<
  PreviewPageReorderRequest,
  PreviewPageReorderRequest
> = z
  .object({
    sessionId: SessionIdSchema,
    pageId: z.string().min(1),
    toIndex: z.number().int().nonnegative(),
  })
  .strict();

/**
 * One keystroke main claimed from a page and handed back to the console to replay.
 *
 * It carries the `KeyboardEvent` members a chord is matched on and nothing that
 * names an action: the console publishes which chords exist, never what they do,
 * and replays the keystroke through its own bindings. `isComposing` is carried
 * because a keystroke inside an input-method composition is never claimed, and only
 * the event itself knows that it was one.
 */
export interface BrowserPageChord {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
}
