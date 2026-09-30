// The closed set of subsystems allowed to move the transcript. A leaf module because
// `scroll-frame-writes.ts` queues writes by caller and the chokepoint holds that queue, so a
// union declared in either would close an import cycle.

/**
/**
 * Every subsystem allowed to move the transcript. Closed.
 *
 * A caller not on this list has not decided how it arbitrates against the ones that are.
 * `measurement-compensation` is the virtualizer's: when a row above the fold measures differently
 * than estimated, the library offers to subtract the difference from the offset. The reading
 * anchor decides whether that happens and the scroll controller performs it, so the library
 * never writes the offset itself.
 */
export const SCROLL_CALLERS = [
  "follow-tail",
  "jump-to-tail",
  "hold-reading-position",
  "deep-link",
  "find-match",
  "prune-compensation",
  "measurement-compensation",
] as const;

/** One scroll caller. Derived from the enumeration, never restated. */
export type ScrollCaller = (typeof SCROLL_CALLERS)[number];
