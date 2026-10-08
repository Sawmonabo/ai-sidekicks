// The edges of the window a store holds of its session's log, and the three ways they move besides
// the stream: a page read before the head grows it backward, a page read after a detached tail
// grows it forward, and a release lets go of rows far from where the person reads. Pure folds, so
// the store holds no arithmetic; `sequence-reconciler.ts` owns the stream's direction, and its
// vocabulary would call a row from beyond an edge a duplicate or a divergence.
//
// A page obeys three rules:
//   - Beyond its edge, or not at all. A row at or inside the span held is already the window's; a
//     second copy would put one row in the log twice. A page that overlaps was asked from the
//     wrong position, and merging the overlap would hide that.
//   - One row per sequence. A page repeating a sequence keeps its first row.
//   - In the page's order. The daemon answers oldest to newest, so its rows are used as they
//     arrived; sorting would be a second ordering of one log.
//
// Nothing here projects an entity or moves the stream's cursor, which is what makes a page safe: a
// partition holds the newest state of each entity, and an older event's projector would replace a
// run's current state with an earlier one. A page does advance the hue wheel and the
// waiting-on-person register, since a recovered row is what it is worth to them.

import type { EventCursor } from "@ai-sidekicks/contracts/session/event-cursor";

import { AgentHueAllocator } from "#renderer/styles/agent-hue.js";
import type { ProjectedSessionEvent } from "./entities/vocabulary.js";
import { WaitingOnPersonRegister } from "./waiting-on-person/register.js";
import { isReconcilableSequence, orderBatchBySequence } from "./sequence-reconciler.js";
import {
  heldRowCursor,
  liveTailAfter,
  type SessionStoreState,
  type TranscriptWindowEdge,
  type TranscriptWindowTail,
} from "./state.js";

/** What one backward page added before a window's head, and what it could not. */
export interface EarlierWindowMerge {
  /** The log with the page's admitted rows in front of it, oldest first. */
  readonly transcript: readonly ProjectedSessionEvent[];
  /** Rows admitted at the head. */
  readonly admitted: number;
  /**
   * Rows refused for sitting at or above the window's oldest row. Counted so a caller seeing zero
   * admitted beside a non-zero overlap knows the page was asked from a position that is not the
   * window's head.
   */
  readonly refusedNotEarlier: number;
  /** Rows refused for repeating a sequence the page itself already carried. */
  readonly duplicates: number;
}

/** What one forward page added after a window's tail, and what it could not. */
export interface LaterWindowMerge {
  /** The log with the page's admitted rows after it, oldest first. */
  readonly transcript: readonly ProjectedSessionEvent[];
  /** Rows admitted at the tail. */
  readonly admitted: number;
  /**
   * Rows refused for sitting at or below the window's newest row, or for arriving while the tail
   * is live, which the stream extends itself.
   */
  readonly refusedNotLater: number;
  /** Rows refused for repeating a sequence the page itself already carried. */
  readonly duplicates: number;
}

/** Everything a page fold advances beside the state it answers with. */
export interface TranscriptPageDependencies {
  readonly sessionId: string;
  readonly hueAllocator: AgentHueAllocator;
  /** The register of what is still waiting on a person. Recovered rows advance it too. */
  readonly waitingOnPersonRegister: WaitingOnPersonRegister;
}

/** What one page did, and the state that records it. */
export interface TranscriptPageFold<Merge> {
  readonly merge: Merge;
  /** The state to commit, or `undefined` where the page moved nothing. */
  readonly nextState: SessionStoreState | undefined;
}

/**
 * Grow a log at its head with the rows a backward page carried. An empty log admits every row of
 * the page. The existing array is returned unchanged when nothing was admitted, so a consumer keyed
 * on the log's identity does not re-project.
 */
export function mergeEarlierWindow(
  transcript: readonly ProjectedSessionEvent[],
  earlier: readonly ProjectedSessionEvent[],
): EarlierWindowMerge {
  const headSequence = transcript[0]?.sequence;
  const { rows, refusedInside, duplicates } = rowsBeyondEdge(
    earlier,
    (sequence) => headSequence !== undefined && sequence >= headSequence,
  );
  return {
    transcript: rows.length === 0 ? transcript : [...rows, ...transcript],
    admitted: rows.length,
    refusedNotEarlier: refusedInside,
    duplicates,
  };
}

/**
 * One backward page, from the rows it carried to the state a store commits. The head takes the
 * page's edge when the page admitted rows, or carried none, which is the walk reaching the log's
 * start; a page refused whole leaves it where it was. A foreign session is refused as on the
 * forward path, since a misrouted page would put another session's rows under this session's ids.
 */
export function foldEarlierWindowPage(
  current: SessionStoreState,
  events: readonly ProjectedSessionEvent[],
  edge: TranscriptWindowEdge,
  dependencies: TranscriptPageDependencies,
): TranscriptPageFold<EarlierWindowMerge> {
  const admissible = admissibleRows(events, dependencies.sessionId);
  const merge = mergeEarlierWindow(current.transcript, admissible);
  if (merge.admitted === 0 && events.length > 0) {
    return { merge, nextState: undefined };
  }
  recoverRows(admissible, dependencies);
  return {
    merge,
    nextState: {
      ...current,
      transcript: merge.transcript,
      transcriptHead: edge,
      revision: current.revision + 1,
    },
  };
}

/**
 * One forward page after a detached tail, from the rows it carried to the state a store commits.
 * The tail goes live again once nothing lies beyond the page or the window reaches what the stream
 * has delivered, since the stream extends it from there; otherwise it stays detached after its
 * newest row. A live tail takes no page.
 */
export function foldLaterWindowPage(
  current: SessionStoreState,
  events: readonly ProjectedSessionEvent[],
  edge: TranscriptWindowEdge,
  dependencies: TranscriptPageDependencies,
): TranscriptPageFold<LaterWindowMerge> {
  if (current.transcriptTail.following === "live") {
    return {
      merge: {
        transcript: current.transcript,
        admitted: 0,
        refusedNotLater: events.length,
        duplicates: 0,
      },
      nextState: undefined,
    };
  }
  const admissible = admissibleRows(events, dependencies.sessionId);
  const tailSequence = current.transcript.at(-1)?.sequence;
  const { rows, refusedInside, duplicates } = rowsBeyondEdge(
    admissible,
    (sequence) => tailSequence !== undefined && sequence <= tailSequence,
  );
  const merge: LaterWindowMerge = {
    transcript: rows.length === 0 ? current.transcript : [...current.transcript, ...rows],
    admitted: rows.length,
    refusedNotLater: refusedInside,
    duplicates,
  };
  if (merge.admitted === 0 && events.length > 0) {
    return { merge, nextState: undefined };
  }
  recoverRows(admissible, dependencies);
  return {
    merge,
    nextState: {
      ...current,
      transcript: merge.transcript,
      transcriptTail: tailAfterLaterPage(merge.transcript, edge, current.cursor),
      revision: current.revision + 1,
    },
  };
}

/**
 * The state with every row outside `[firstKeptCursor, lastKeptCursor]` let go, each edge that
 * moved recording the read that brings its rows back, or `undefined` when nothing was let go. A
 * cursor the window no longer holds, as after a read replaced it, lets go of nothing. Letting go
 * past the newest row detaches the tail.
 */
export function releaseOutsideKept(
  current: SessionStoreState,
  firstKeptCursor: EventCursor,
  lastKeptCursor: EventCursor,
): SessionStoreState | undefined {
  const { transcript } = current;
  const firstKept = transcript.findIndex((row) => row.cursor === firstKeptCursor);
  const lastKept = transcript.findLastIndex((row) => row.cursor === lastKeptCursor);
  if (firstKept === -1 || lastKept < firstKept) {
    return undefined;
  }
  const releasesHead = firstKept > 0;
  const releasesTail = lastKept < transcript.length - 1;
  if (!releasesHead && !releasesTail) {
    return undefined;
  }
  return {
    ...current,
    transcript: transcript.slice(firstKept, lastKept + 1),
    // A backward read answers the rows at or before its cursor, so the head names the newest row
    // let go there; a forward read answers the rows after its cursor, so the tail names the
    // newest row kept.
    transcriptHead: releasesHead
      ? { cursor: heldRowCursor(transcript[firstKept - 1]!), hasMore: true }
      : current.transcriptHead,
    transcriptTail: releasesTail
      ? { cursor: heldRowCursor(transcript[lastKept]!), hasMore: true, following: "detached" }
      : current.transcriptTail,
    revision: current.revision + 1,
  };
}

/** The rows a page may offer this session, in sequence order. */
function admissibleRows(
  events: readonly ProjectedSessionEvent[],
  sessionId: string,
): ProjectedSessionEvent[] {
  return orderBatchBySequence(
    events.filter(
      (event) => event.sessionId === sessionId && isReconcilableSequence(event.sequence),
    ),
  );
}

/** The rows of a page that lie beyond the edge, one per sequence, and what was refused. */
function rowsBeyondEdge(
  page: readonly ProjectedSessionEvent[],
  isInsideWindow: (sequence: number) => boolean,
): {
  readonly rows: readonly ProjectedSessionEvent[];
  readonly refusedInside: number;
  readonly duplicates: number;
} {
  const admittedSequences = new Set<number>();
  const rows: ProjectedSessionEvent[] = [];
  let refusedInside = 0;
  let duplicates = 0;
  for (const event of page) {
    if (isInsideWindow(event.sequence)) {
      refusedInside += 1;
      continue;
    }
    if (admittedSequences.has(event.sequence)) {
      duplicates += 1;
      continue;
    }
    admittedSequences.add(event.sequence);
    rows.push(event);
  }
  return { rows, refusedInside, duplicates };
}

/** Advance the hue wheel and the register by every row a page recovered, in any order. */
function recoverRows(
  rows: readonly ProjectedSessionEvent[],
  dependencies: TranscriptPageDependencies,
): void {
  for (const event of rows) {
    if (event.actorId !== undefined) {
      dependencies.hueAllocator.admit(event.actorId);
    }
  }
  dependencies.waitingOnPersonRegister.admit(rows);
}

/**
 * The tail after a forward page: live once the daemon holds nothing beyond the page or the window
 * reaches the stream's cursor, else detached after its newest row.
 */
function tailAfterLaterPage(
  transcript: readonly ProjectedSessionEvent[],
  edge: TranscriptWindowEdge,
  streamCursor: number,
): TranscriptWindowTail {
  const newest = transcript.at(-1);
  if (!edge.hasMore || newest === undefined || newest.sequence >= streamCursor) {
    return liveTailAfter(transcript);
  }
  return { cursor: heldRowCursor(newest), hasMore: true, following: "detached" };
}
