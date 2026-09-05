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
//
// AND THE WORDS FOR THOSE TWO ARE THE CONSOLE'S, NOT THIS FAMILY'S. Both shapes below
// are `ReadingState` arms with this family's payload attached, rather than a local
// union spelling `served` as `measured` or `read` and `refused` as `unmeasured` or
// `not-read`. `apps/desktop/AGENTS.md` §State and views says a closed set is declared
// once and every consumer derives from it, and the cost of not doing so is not
// aesthetic: a surface holding one of these can be handed straight to
// `readingNoticeFor`, so the sentence a person reads about an incomplete listing is
// the same sentence every other console surface says, and a seventh reading state
// added upstream reaches this family by failing to compile rather than by nobody
// noticing.

import type { ConsoleRefusal } from "../core/index.js";
import type { ReadingState } from "../primitives/index.js";

/** A stored size, or why it could not be measured. Never a zero standing in for either. */
export type BrowserPartitionSize =
  | (Extract<ReadingState, { readonly kind: "served" }> & { readonly byteLength: number })
  | Extract<ReadingState, { readonly kind: "refused" }>;

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
  | (Extract<ReadingState, { readonly kind: "served" }> & {
      readonly partitions: readonly BrowserSitePartition[];
    })
  | Extract<ReadingState, { readonly kind: "reading" }>
  | Extract<ReadingState, { readonly kind: "refused" }>;
