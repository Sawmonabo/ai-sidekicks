// What a backward page may add to a log, and what it may not.
//
// THE ONE RULE THIS MODULE OWNS: a page read backwards grows the log at the HEAD and
// touches nothing else. `sequence-reconciler.ts` owns the forward direction — the
// cursor, the dedupe set, the recorded holes, the divergence bound — and every one of
// those answers is about rows arriving AFTER the position the store has reached. A
// row from before the window's head is none of those things: it is older than the
// cursor by construction, so the reconciler's own vocabulary classifies it as a
// duplicate or a divergence and refuses it, which is the correct answer to the
// question that reconciler is asking and the wrong answer to this one.
//
// SO THE TWO DIRECTIONS ARE TWO RULES AND THIS IS THE SECOND, stated as a pure fold
// so the store that applies it holds no arithmetic:
//
//   • **Strictly earlier, or not at all.** An event at or above the log's head
//     sequence is already this window's — the subscription delivered it, the
//     reconciler admitted it, and a second copy arriving from behind would put one
//     row in the log twice under two identities. There is no repair arm: a page that
//     overlaps is a page the caller asked for from the wrong position, and silently
//     merging the overlap would hide that.
//   • **One row per sequence.** A page repeating a sequence keeps its FIRST row, on
//     `window-cap.ts`' own precedent for a repeated key: the array carries what
//     arrived and the repeat is dropped rather than collapsing two rows into one
//     position nobody can tell apart.
//   • **Oldest first, and the order is the page's.** The daemon answers a window in
//     log order, so the prefix is used as it arrived rather than re-sorted here:
//     sorting would be a second ordering of one log, and the one that decides is the
//     producer's.
//
// AND NOTHING HERE PROJECTS AN ENTITY. That is not an omission — it is the property
// that makes a backward page safe. An entity partition holds the NEWEST state of each
// entity, and running an older event's projector over it would replace a run's
// current state with the state it was in before the window opened. The log grows; the
// projection of the present does not move.

import type { ConsoleSessionEvent } from "./entities.js";

/** What one backward page added to a log, and what it could not. */
export interface EarlierWindowMerge {
  /** The log with the page's admitted rows in front of it, oldest first. */
  readonly timeline: readonly ConsoleSessionEvent[];
  /** Rows admitted at the head. */
  readonly admitted: number;
  /**
   * Rows refused for sitting at or above the log's head sequence.
   *
   * Counted rather than dropped quietly: a page that overlaps the window was asked
   * for from a position that is not this window's head, and a caller reading zero
   * admitted rows beside a non-zero overlap knows which of the two things happened.
   */
  readonly refusedNotEarlier: number;
  /** Rows refused for repeating a sequence the page itself already carried. */
  readonly duplicates: number;
}

/**
 * Grow a log at its head with the rows a backward page carried.
 *
 * `headSequence` is the sequence of the log's oldest row, or `undefined` for a log
 * that holds none — where every row of the page is earlier than everything the
 * window has, which is the honest reading of an empty log rather than a reason to
 * refuse the page.
 *
 * The existing array's identity is returned unchanged when nothing was admitted, so a
 * consumer keyed on the log's identity does not re-project for a page that added
 * nothing.
 */
export function mergeEarlierWindow(
  timeline: readonly ConsoleSessionEvent[],
  earlier: readonly ConsoleSessionEvent[],
): EarlierWindowMerge {
  const headSequence = timeline[0]?.sequence;
  const admittedSequences = new Set<number>();
  const prefix: ConsoleSessionEvent[] = [];
  let refusedNotEarlier = 0;
  let duplicates = 0;

  for (const event of earlier) {
    if (headSequence !== undefined && event.sequence >= headSequence) {
      refusedNotEarlier += 1;
      continue;
    }
    if (admittedSequences.has(event.sequence)) {
      duplicates += 1;
      continue;
    }
    admittedSequences.add(event.sequence);
    prefix.push(event);
  }

  return {
    timeline: prefix.length === 0 ? timeline : [...prefix, ...timeline],
    admitted: prefix.length,
    refusedNotEarlier,
    duplicates,
  };
}
