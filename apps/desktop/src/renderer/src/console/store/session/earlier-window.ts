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

import { ParticipantHueAllocator } from "../../tokens/index.js";
import type { ConsoleSessionEvent } from "../entities/index.js";
import { OutstandingAskJournal } from "./outstanding-asks/index.js";
import { isReconcilableSequence, orderBatchBySequence } from "./sequence-reconciler.js";
import { capTimeline, type SessionStoreState, type TimelineRetainedEnd } from "./session-state.js";

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

/** Everything the state-level fold below advances beside the state it answers with. */
export interface EarlierWindowCollaborators {
  readonly sessionId: string;
  readonly hueAllocator: ParticipantHueAllocator;
  /** The ledger of what is still waiting on a person. Recovered rows advance it too. */
  readonly outstandingAsks: OutstandingAskJournal;
  readonly timelineCap: number | undefined;
}

/**
 * Which end of an over-cap log survives a backward page, and why it is a constant.
 *
 * A page that admitted nothing never reaches the cap — the fold answers with no state
 * at all — so every path that caps here is a path on which a row has just landed at the
 * head. A reader who asked for the rows before the window's head has moved to the head,
 * so the cap cuts the end they left rather than the end they went to. Cutting the other
 * way would discard the page as it landed, and every press after it.
 */
const EARLIER_PAGE_RETAINED_END: TimelineRetainedEnd = "oldest";

/** What one backward page did, and the state that records it. */
export interface EarlierWindowFold {
  readonly merge: EarlierWindowMerge;
  /** The state to commit, or `undefined` where the page admitted nothing. */
  readonly nextState: SessionStoreState | undefined;
}

/**
 * One backward page, from the rows it carried to the state a store commits.
 *
 * BESIDE THE RULE IT APPLIES rather than in the store, on `applied-batch-fold.ts`'
 * precedent and this module's own opening claim: the rule is stated here as a pure fold
 * so the store holds no arithmetic, and the state-level half is the same claim one level
 * up. A foreign session is refused here as it is on the forward path, and for the same
 * reason: two sessions never share a store, and a page routed to the wrong one would put
 * another session's rows under this session's ids.
 *
 * It advances the collaborators it is handed and sets nothing: the hue wheel takes every
 * recovered author, and the outstanding-ask register takes every recovered row — which
 * is the whole value of a backward page to it, since those rows are the ones the window
 * was never sent and the register is order-insensitive by construction.
 */
export function foldEarlierWindowPage(
  current: SessionStoreState,
  events: readonly ConsoleSessionEvent[],
  collaborators: EarlierWindowCollaborators,
): EarlierWindowFold {
  const admissible = orderBatchBySequence(
    events.filter(
      (event) =>
        event.sessionId === collaborators.sessionId && isReconcilableSequence(event.sequence),
    ),
  );
  const merge = mergeEarlierWindow(current.timeline, admissible);
  if (merge.admitted === 0) {
    return { merge, nextState: undefined };
  }
  for (const event of admissible) {
    if (event.actorId !== undefined) {
      collaborators.hueAllocator.admit(event.actorId);
    }
  }
  collaborators.outstandingAsks.admit(admissible);
  return {
    merge,
    nextState: {
      ...current,
      timeline: capTimeline(merge.timeline, collaborators.timelineCap, EARLIER_PAGE_RETAINED_END),
      revision: current.revision + 1,
    },
  };
}
