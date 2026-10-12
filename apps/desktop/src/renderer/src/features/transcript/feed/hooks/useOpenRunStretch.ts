// A press on a long run's edge line opens the next stretch of its window. Where the store let go
// of the calls past that edge, they are read back once the edge line comes within the drawn band's
// reach, one page per edge, inside the store's window or past its edge, so a press opens at once
// onto rows the log holds. A press before that page lands waits for it, and one on an edge whose
// page was never read reads it first. A read that brings none of them, or has nothing to send,
// opens what the log holds.

import { useCallback, useEffect, useRef, useState } from "react";

import { heldRowCursor, type ReleasedEventStretch } from "#renderer/store/session/state.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { type TranscriptHistory } from "../../history/hooks/useTranscriptHistory.js";
import { type TranscriptHistoryState } from "../../history/reader.js";
import {
  readRunWindowEdgeKey,
  rowBesideRunWindowEdge,
  runWindowEdgeKey,
  type RunCallWindow,
  type RunWindowEdge,
} from "../../runs/call-window.js";
import { type ReleasedRunEntries, type RunGroup } from "../../runs/groups.js";
import { type TranscriptWindowModel } from "../../window/transcript-window.js";

/** What a press reads back through, and how it opens a stretch over the rows the log holds. */
export interface OpenRunStretchInputs {
  /** The reader the let-go calls are read back through; with none, a press opens what is held. */
  readonly history: TranscriptHistory | undefined;
  readonly sessionStore: SessionStore;
  /** Every row of every run group, before any fold. */
  readonly unfurledWindow: TranscriptWindowModel;
  /** An open run group's window as the feed last cut it, or `undefined` for a folded group. */
  readonly callWindowOf: (runGroupKey: string) => RunCallWindow | undefined;
  /** The keys of the edge lines within the drawn band's reach as the viewport last walked it. */
  readonly edgeKeysInReach: () => ReadonlySet<string>;
  /** Opens the next stretch beyond `edge` over the rows of `runGroup` the log holds. */
  readonly openHeldStretch: (runGroup: RunGroup, edge: RunWindowEdge) => void;
}

/**
 * Answers the act a press on a run group's edge line runs: the next stretch beyond that edge, at
 * once where the log holds calls there, else once the calls the store let go there are read back.
 * Reads that page ahead for each edge line within the drawn band's reach.
 */
export function useOpenRunStretch(
  inputs: OpenRunStretchInputs,
): (runGroup: RunGroup, edge: RunWindowEdge) => void {
  const { history, sessionStore, unfurledWindow, callWindowOf, edgeKeysInReach, openHeldStretch } =
    inputs;
  const [pending, setPending] = useState<PendingOpen | undefined>(undefined);
  /** The page read ahead for each edge line in reach, by its key: one per row beside the edge. */
  const readsAhead = useRef(new Map<string, ReadAhead>());
  // After every commit, since the band's walks and the reader's moves each commit the feed: an
  // edge line that came within reach reads its page once no read is under way, and one that left
  // it forgets its page, which the store lets go at its next release.
  useEffect(() => {
    const inReach = edgeKeysInReach();
    for (const edgeKey of readsAhead.current.keys()) {
      if (!inReach.has(edgeKey)) {
        readsAhead.current.delete(edgeKey);
      }
    }
    if (history === undefined || isAnyReadUnderWay(history.state)) {
      return;
    }
    for (const edgeKey of inReach) {
      const edgeRow = readRunWindowEdgeKey(edgeKey, unfurledWindow.runGroupByHeaderKey);
      const window = edgeRow === undefined ? undefined : callWindowOf(edgeRow.runGroup.key);
      const owed =
        edgeRow === undefined || window === undefined
          ? undefined
          : owedReadBack(unfurledWindow, edgeRow.runGroup, window, edgeRow.edge);
      if (
        edgeRow === undefined ||
        owed === undefined ||
        readsAhead.current.get(edgeKey)?.besideRowId === owed.besideRowId
      ) {
        continue;
      }
      // A failed read is sent again by the person's `Try again` or the catch-up line, never ahead.
      const readBack = releasedReadBack(sessionStore, edgeRow.edge, owed);
      if (!history.state[readBack.place].hasFailed && readBack.start(history)) {
        readsAhead.current.set(edgeKey, { besideRowId: owed.besideRowId, place: readBack.place });
        return;
      }
    }
  });
  // Once the read lands, or ends with nothing to show for it, on the group that now holds the row
  // beside the pressed edge.
  useEffect(() => {
    if (pending === undefined) {
      return;
    }
    const runGroupKey = unfurledWindow.runGroupKeyByRowId.get(pending.besideRowId);
    const runGroup =
      runGroupKey === undefined ? undefined : unfurledWindow.runGroupByHeaderKey.get(runGroupKey);
    if (runGroup === undefined) {
      setPending(undefined);
      return;
    }
    const read = history?.state[pending.place];
    const isLanded = (releasedBeyond(runGroup, pending.edge)?.count ?? 0) < pending.releasedCount;
    if (isLanded || read === undefined || (!read.isReading && !read.hasFailed)) {
      setPending(undefined);
      openHeldStretch(runGroup, pending.edge);
    }
  }, [pending, unfurledWindow, history, openHeldStretch]);
  return useCallback(
    (runGroup: RunGroup, edge: RunWindowEdge) => {
      const window = callWindowOf(runGroup.key);
      const owed =
        window === undefined ? undefined : owedReadBack(unfurledWindow, runGroup, window, edge);
      if (owed === undefined || history === undefined) {
        openHeldStretch(runGroup, edge);
        return;
      }
      // The page read ahead for this edge is still on its way: the press waits for it.
      const readAhead = readsAhead.current.get(runWindowEdgeKey(runGroup.key, edge));
      const readBack = releasedReadBack(sessionStore, edge, owed);
      const place =
        readAhead?.besideRowId === owed.besideRowId && history.state[readAhead.place].isReading
          ? readAhead.place
          : readBack.start(history)
            ? readBack.place
            : undefined;
      if (place === undefined) {
        openHeldStretch(runGroup, edge);
        return;
      }
      setPending({
        besideRowId: owed.besideRowId,
        edge,
        releasedCount: owed.released.count,
        place,
      });
    },
    [history, sessionStore, unfurledWindow, callWindowOf, openHeldStretch],
  );
}

/** A press waiting on its read: the row beside the edge, and the let-go count it waits to drop. */
interface PendingOpen {
  readonly besideRowId: string;
  readonly edge: RunWindowEdge;
  readonly releasedCount: number;
  readonly place: keyof TranscriptHistoryState;
}

/** The page read ahead for one edge line: the row beside the edge then, and where it reads. */
interface ReadAhead {
  readonly besideRowId: string;
  readonly place: keyof TranscriptHistoryState;
}

/** The calls an edge's next stretch would read back, and the row beside that edge. */
interface OwedReadBack {
  readonly released: ReleasedRunEntries;
  readonly besideRowId: string;
  readonly besideSequence: number;
}

/** A read of the calls let go beyond an edge: where it reads, and how it starts. */
interface ReleasedReadBack {
  readonly place: keyof TranscriptHistoryState;
  /** Starts the read; answers whether it is under way. */
  readonly start: (history: TranscriptHistory) => boolean;
}

function releasedBeyond(runGroup: RunGroup, edge: RunWindowEdge): ReleasedRunEntries | undefined {
  return edge === "earlier" ? runGroup.releasedEarlier : runGroup.releasedLater;
}

function isAnyReadUnderWay(state: TranscriptHistoryState): boolean {
  return state.earlier.isReading || state.later.isReading || state.inside.isReading;
}

/**
 * What the next stretch beyond `edge` of `window` reads back first, or `undefined` when it opens
 * at once: the log holds calls beyond that edge, or the store let none go there.
 */
function owedReadBack(
  unfurledWindow: TranscriptWindowModel,
  runGroup: RunGroup,
  window: RunCallWindow,
  edge: RunWindowEdge,
): OwedReadBack | undefined {
  const released = releasedBeyond(runGroup, edge);
  const isOutermost =
    edge === "earlier"
      ? window.firstCallIndex === 0
      : window.endCallIndex >= runGroup.drawnRowPositions.length;
  const besideRowId = rowBesideRunWindowEdge(runGroup, window, edge);
  const besideRow =
    besideRowId === undefined ? undefined : unfurledWindow.rowsByKey.get(besideRowId);
  return released === undefined ||
    !isOutermost ||
    besideRowId === undefined ||
    besideRow === undefined
    ? undefined
    : { released, besideRowId, besideSequence: besideRow.sequence };
}

/**
 * The read of the calls `owed` names, let go beyond `edge`: inside the stretch the store let go
 * next to the row beside that edge, else past the store's edge.
 */
function releasedReadBack(
  sessionStore: SessionStore,
  edge: RunWindowEdge,
  owed: OwedReadBack,
): ReleasedReadBack {
  const stretch = adjoiningStretch(sessionStore, edge, owed.besideSequence, owed.released);
  if (stretch !== undefined) {
    return {
      place: "inside",
      start: (history) =>
        history.readReleasedStretch(stretch, edge === "earlier" ? "backward" : "forward"),
    };
  }
  return edge === "earlier"
    ? { place: "earlier", start: (history) => history.readStretch("head") }
    : { place: "later", start: (history) => history.readStretch("tail") };
}

/**
 * The stretch the store let go nearest the group's row at `besideSequence` on the `edge` side,
 * among those holding the group's let-go calls, or `undefined` when they went past an edge.
 */
function adjoiningStretch(
  sessionStore: SessionStore,
  edge: RunWindowEdge,
  besideSequence: number,
  released: ReleasedRunEntries,
): ReleasedEventStretch | undefined {
  const { transcript, releasedStretches } = sessionStore.snapshot();
  let nearest: { stretch: ReleasedEventStretch; upperSequence: number } | undefined;
  for (const stretch of releasedStretches) {
    const upperSequence = transcript.find(
      (event) => heldRowCursor(event) === stretch.firstHeldCursorAfter,
    )?.sequence;
    const lowerSequence = stretch.lastHeldSequenceBefore;
    const isBeside =
      upperSequence !== undefined &&
      (edge === "earlier" ? upperSequence <= besideSequence : lowerSequence >= besideSequence) &&
      lowerSequence < released.toSequence &&
      upperSequence > released.fromSequence;
    const isNearer =
      nearest === undefined ||
      (edge === "earlier"
        ? (upperSequence ?? 0) > nearest.upperSequence
        : lowerSequence < nearest.stretch.lastHeldSequenceBefore);
    if (isBeside && isNearer) {
      nearest = { stretch, upperSequence };
    }
  }
  return nearest?.stretch;
}
