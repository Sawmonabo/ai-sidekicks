// The closed set of subsystems allowed to move a scroll container. A leaf module because
// `frame-writes.ts` queues writes by caller and the chokepoint holds that queue, so a
// union declared in either would close an import cycle.

/**
 * Every subsystem allowed to move a scroll container. Closed.
 *
 * A caller not on this list has not decided how it arbitrates against the ones that are.
 * `follow-tail` is the transcript keeping a following reader on its last row: the list window's
 * end anchor as rows measure, its landing on each appended row, and a tail jump's re-aims once the
 * reader follows again. `follow-arriving-text` is the transcript easing a following reader after
 * the text arriving in its revealing last row, where `follow-tail` places a layout correction at
 * once. `jump-to-tail` and `jump-to-head` are the transcript's jumps to its last
 * and first row: the pill, the palette and End, and Home.
 * `message-anchor` is the landing on the message a link names, when a session opens at it.
 * `measurement-compensation` is a list window's: when a row above the fold measures differently
 * than estimated, the library offers to subtract the difference from the offset. In the transcript
 * the reading anchor decides whether that happens; the scroll controller performs it, so the
 * library never writes the offset itself.
 * `window-opening` is a list window putting a box it just took at the offset it holds: where the
 * list opens, a selection far down it included. `row-reveal` is a list window scrolling the least
 * distance that brings a row into view: the keyboard's row in a roving list, the palette's
 * highlighted match; in the transcript, it lands at the top of the view on a row the window let go
 * that a shift-arrow moves a selection's end into.
 * `settings-control-landing` is Settings putting the control a link or a search hit names in the
 * middle of the view, once, when the person arrives on it.
 */
export const SCROLL_CALLERS = [
  "follow-tail",
  "follow-arriving-text",
  "jump-to-tail",
  "jump-to-head",
  "hold-reading-position",
  "find-match",
  "message-anchor",
  "prune-compensation",
  "measurement-compensation",
  "window-opening",
  "row-reveal",
  "settings-control-landing",
] as const;

/** One scroll caller. Derived from the enumeration, never restated. */
export type ScrollCaller = (typeof SCROLL_CALLERS)[number];
