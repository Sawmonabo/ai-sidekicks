// The site-data partition model chapter 13.16 renders, held apart from the page that
// renders it.
//
// A partition is what one session's browser panes have written to disk, and the page,
// the table, and the row all read the same three shapes. Holding them here rather than
// on the page keeps the table and the row importable without importing the page they
// compose — an import that would run the other way and close a cycle.
//
// EVERY FIGURE IS A READING OR A REFUSAL. `BrowserPartitionSize` has no zero arm: a
// size the node could not measure arrives as the refusal that says so, because a zero
// standing in for an unmeasured partition would read as "nothing stored here" and that
// is the one claim a clear control must not make falsely.

import type { ConsoleRefusal } from "../core/index.js";

/** A stored size, or why it could not be measured. Never a zero standing in for either. */
export type BrowserPartitionSize =
  | { readonly status: "measured"; readonly byteLength: number }
  | { readonly status: "unmeasured"; readonly refusal: ConsoleRefusal };

export interface BrowserSitePartition {
  /** The owning session, wire-verbatim. */
  readonly sessionId: string;
  /** The session's title, as the console shows it elsewhere. */
  readonly sessionTitle: string;
  readonly size: BrowserPartitionSize;
  /**
   * True while a browser pane in that session still holds the partition open.
   * Daemon-supplied: 13.16 forbids clearing under an open pane, and a renderer that
   * decided this for itself would be a second source of truth for pane liveness.
   */
  readonly hasOpenPane: boolean;
  /** A clear that failed, rendered on its own row rather than as a page banner. */
  readonly lastClearRefusal?: ConsoleRefusal | undefined;
}

/** What the node said about its partitions, or why it said nothing. */
export type BrowserPartitionListing =
  | { readonly status: "not-read"; readonly refusal: ConsoleRefusal }
  | { readonly status: "reading" }
  | { readonly status: "read"; readonly partitions: readonly BrowserSitePartition[] };
