// What a backward page may add to a log, and what it may not: a page read backwards grows the log
// at the head and touches nothing else. `sequence-reconciler.ts` owns the forward direction, and
// its vocabulary would classify a row from before the window's head as a duplicate or a
// divergence and refuse it, which is the wrong answer here. This is the second rule, a pure fold
// so the store holds no arithmetic:
//   - Strictly earlier, or not at all. An event at or above the log's head sequence is already
//     this window's; a second copy would put one row in the log twice. A page that overlaps was
//     asked for from the wrong position, and merging the overlap would hide that.
//   - One row per sequence. A page repeating a sequence keeps its first row.
//   - Oldest first, in the page's order. The daemon answers in log order, so the prefix is used
//     as it arrived; sorting would be a second ordering of one log.
//
// Nothing here projects an entity, which is what makes a backward page safe: a partition holds
// the newest state of each entity, and an older event's projector would replace a run's current
// state with the state it had before the window opened.

import { AgentHueAllocator } from "#renderer/styles/agent-hue.js";
import type { ProjectedSessionEvent } from "./entities/entities.js";
import { WaitingOnPersonRegister } from "./waiting-on-person/waiting-on-person-register.js";
import { isReconcilableSequence, orderBatchBySequence } from "./sequence-reconciler.js";
import { capTranscript, type SessionStoreState, type TranscriptRetainedEnd } from "./state.js";

/** What one backward page added to a log, and what it could not. */
export interface EarlierWindowMerge {
  /** The log with the page's admitted rows in front of it, oldest first. */
  readonly transcript: readonly ProjectedSessionEvent[];
  /** Rows admitted at the head. */
  readonly admitted: number;
  /**
   * Rows refused for sitting at or above the log's head sequence. Counted so a caller seeing zero
   * admitted beside a non-zero overlap knows the page was asked from a position that is not the
   * window's head.
   */
  readonly refusedNotEarlier: number;
  /** Rows refused for repeating a sequence the page itself already carried. */
  readonly duplicates: number;
}

/** Everything the state-level fold below advances beside the state it answers with. */
export interface EarlierWindowDependencies {
  readonly sessionId: string;
  readonly hueAllocator: AgentHueAllocator;
  /** The register of what is still waiting on a person. Recovered rows advance it too. */
  readonly waitingOnPersonRegister: WaitingOnPersonRegister;
  readonly transcriptCap: number | undefined;
}

/**
 * Grow a log at its head with the rows a backward page carried. An empty log admits every row
 * of the page. The existing array is returned unchanged when nothing was admitted, so a
 * consumer keyed on the log's identity does not re-project.
 */
export function mergeEarlierWindow(
  transcript: readonly ProjectedSessionEvent[],
  earlier: readonly ProjectedSessionEvent[],
): EarlierWindowMerge {
  const headSequence = transcript[0]?.sequence;
  const admittedSequences = new Set<number>();
  const prefix: ProjectedSessionEvent[] = [];
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
    transcript: prefix.length === 0 ? transcript : [...prefix, ...transcript],
    admitted: prefix.length,
    refusedNotEarlier,
    duplicates,
  };
}

/**
 * Which end of an over-cap log survives a backward page. A page that admitted nothing never
 * reaches the cap, and the reader has moved to the head, so the cap cuts the end they left;
 * cutting the other way would discard the page as it landed.
 */
const EARLIER_PAGE_RETAINED_END: TranscriptRetainedEnd = "oldest";

/** What one backward page did, and the state that records it. */
export interface EarlierWindowFold {
  readonly merge: EarlierWindowMerge;
  /** The state to commit, or `undefined` where the page admitted nothing. */
  readonly nextState: SessionStoreState | undefined;
}

/**
 * One backward page, from the rows it carried to the state a store commits. A foreign session
 * is refused as on the forward path, since a misrouted page would put another session's rows
 * under this session's ids.
 *
 * It sets nothing and advances the dependencies it is handed: the hue wheel takes every
 * recovered author, and the waiting-on-person register takes every recovered row, which is the
 * value of a backward page to it and is order-insensitive by construction.
 */
export function foldEarlierWindowPage(
  current: SessionStoreState,
  events: readonly ProjectedSessionEvent[],
  dependencies: EarlierWindowDependencies,
): EarlierWindowFold {
  const admissible = orderBatchBySequence(
    events.filter(
      (event) =>
        event.sessionId === dependencies.sessionId && isReconcilableSequence(event.sequence),
    ),
  );
  const merge = mergeEarlierWindow(current.transcript, admissible);
  if (merge.admitted === 0) {
    return { merge, nextState: undefined };
  }
  for (const event of admissible) {
    if (event.actorId !== undefined) {
      dependencies.hueAllocator.admit(event.actorId);
    }
  }
  dependencies.waitingOnPersonRegister.admit(admissible);
  return {
    merge,
    nextState: {
      ...current,
      transcript: capTranscript(
        merge.transcript,
        dependencies.transcriptCap,
        EARLIER_PAGE_RETAINED_END,
      ),
      revision: current.revision + 1,
    },
  };
}
