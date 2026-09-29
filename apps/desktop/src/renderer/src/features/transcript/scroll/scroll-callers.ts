// The closed set of subsystems allowed to move the ledger.
//
// Its own leaf module rather than a declaration inside `scroll-chokepoint.ts`, for a
// reason the split made unavoidable: `scroll-frame-writes.ts` queues writes BY caller
// and the chokepoint holds that queue, so a union declared in either one would close a
// cycle `no-circular` fails. A closed set both sides of a seam speak belongs under
// both of them, which is here.

/**
 * Every subsystem allowed to move the ledger. Closed, and closed here.
 *
 * A caller that is not on this list has not decided how it arbitrates against the
 * ones that are — which is the question the union exists to force.
 *
 * `measurement-compensation` is the virtualizer's: when a row above the fold
 * measures taller or shorter than it was estimated, every offset below it moves,
 * and the library offers to subtract the difference from the offset so the reader
 * does not. The reading anchor decides WHETHER that happens; the library computes
 * how much; the scroll controller performs it. A library that wrote the offset itself
 * would be the second writer this union exists to prevent.
 */
export const LEDGER_SCROLL_CALLERS = [
  "follow-tail",
  "jump-to-tail",
  "hold-reading-position",
  "deep-link",
  "find-match",
  "prune-compensation",
  "measurement-compensation",
] as const;

/** One scroll caller. Derived from the enumeration, never restated. */
export type LedgerScrollCaller = (typeof LEDGER_SCROLL_CALLERS)[number];
