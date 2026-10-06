// The closed set of subsystems allowed to move a scroll container. A leaf module because
// `frame-writes.ts` queues writes by caller and the chokepoint holds that queue, so a
// union declared in either would close an import cycle.

/**
 * Every subsystem allowed to move a scroll container. Closed.
 *
 * A caller not on this list has not decided how it arbitrates against the ones that are.
 * `message-anchor` is the landing on the message a link names, when a session opens at it.
 * `measurement-compensation` is a list window's: when a row above the fold measures differently
 * than estimated, the library offers to subtract the difference from the offset. In the transcript
 * the reading anchor decides whether that happens; the scroll controller performs it, so the
 * library never writes the offset itself.
 * `window-opening` is a list window putting a box it just took at the offset it holds: where the
 * list opens, a selection far down it included. `row-reveal` is a list window scrolling the least
 * distance that brings a row into view: the keyboard's row in a roving list, the palette's
 * highlighted match. `settings-control-landing` is Settings putting the control a link or a search
 * hit names in the middle of the view, once, when the person arrives on it.
 */
export const SCROLL_CALLERS = [
  "follow-tail",
  "jump-to-tail",
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
