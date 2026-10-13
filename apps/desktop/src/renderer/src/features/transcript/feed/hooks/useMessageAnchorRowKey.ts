// The row a link to a message lands on. The link names the message by its event cursor, which the
// store's log carries on every event, streamed or read back. A message outside the window is
// reached by reading stretches through the feed's history until the log holds it; one inside a
// folded run group has the group opened first, once, so the row is drawn rather than hidden under
// a header. An event the feed draws nothing for lands on the nearest row it does draw.

import { useEffect, useMemo, useRef, useState } from "react";

import { useSessionStore } from "#renderer/store/session/hooks/useOpenSessionStore.js";
import {
  type ProjectedSessionEvent,
  type ProjectedTranscriptRow,
} from "#renderer/store/session/entities/vocabulary.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { type SessionStoreState } from "#renderer/store/session/state.js";
import { type RunGroup } from "../../runs/groups.js";
import { type TranscriptHistory } from "../../history/hooks/useTranscriptHistory.js";
import { type HistoryEdgeState } from "../../history/reader.js";
import { type TranscriptWindowModel } from "../../window/transcript-window.js";
import { type MessageReadBack } from "../../viewport/landing.js";

/** What the landing row is looked up in. */
export interface MessageAnchorRowKeyInputs {
  readonly sessionStore: SessionStore;
  /** The cursor of the message to land on, or `undefined` for an ordinary open. */
  readonly messageAnchorCursor: string | undefined;
  /** The history a message older than the window is read back through, or none to read with. */
  readonly history: TranscriptHistory | undefined;
  /** Every row of every run group, before any fold. */
  readonly unfurledWindow: TranscriptWindowModel;
  /** The window the viewport draws: folded by run group, its lists holding only drawn rows. */
  readonly transcriptWindow: TranscriptWindowModel;
  /** Whether the feed draws a row at all. */
  readonly drawsRow: (row: ProjectedTranscriptRow) => boolean;
  /** Open one run group, if it is folded. */
  readonly openRunGroup: (runGroupKey: string) => void;
}

/** Where a link to a message stands: the row it lands on, and how reading back toward it goes. */
export interface MessageAnchorLanding {
  /**
   * The key of the drawn row the message cursor names, or `undefined` while there is none: no
   * cursor, or a cursor the log does not hold (yet, or at all).
   */
  readonly landingRowKey: string | undefined;
  /** The reading back toward a message the log lacks, or `undefined` when none is owed. */
  readonly readBack: MessageReadBack | undefined;
}

/**
 * The row a link to a message lands on. An event the feed draws nothing for lands on the next
 * drawn row after it in log order, else the one before it. While the log lacks the event, this
 * reads back one stretch at a time until it arrives, history starts or a read fails. Nothing
 * stands in for a missing row, so the transcript opens as it would with no link.
 */
export function useMessageAnchorRowKey(inputs: MessageAnchorRowKeyInputs): MessageAnchorLanding {
  const { sessionStore, messageAnchorCursor, unfurledWindow, transcriptWindow, drawsRow } = inputs;
  // The log's oldest event moves when the log is first read and when a page lands before it, and
  // its newest past a let-go tail when a page lands after it: the only times a message the log
  // lacked can arrive. Keyed on them, the lookup runs then and not on every streamed append.
  const oldestEvent = useSessionStore(sessionStore, selectOldestEvent);
  const newestDetachedEvent = useSessionStore(sessionStore, selectNewestDetachedEvent);
  const eventId = useMemo(
    () =>
      messageAnchorCursor === undefined || oldestEvent === undefined
        ? undefined
        : sessionStore.readable
            .getState()
            .transcript.find((event) => event.cursor === messageAnchorCursor)?.id,
    [sessionStore, messageAnchorCursor, oldestEvent, newestDetachedEvent],
  );
  const readBack = useReadBackToMessage(messageAnchorCursor, eventId, inputs.history);
  const foldedRunGroup = useMemo(
    () => runGroupFoldingAway(eventId, unfurledWindow, transcriptWindow),
    [eventId, unfurledWindow, transcriptWindow],
  );

  const landingRowKey = useMemo(
    () => landingRowKeyFor(eventId, unfurledWindow, transcriptWindow, drawsRow),
    [eventId, unfurledWindow, transcriptWindow, drawsRow],
  );

  // Settled once per link, when the row is first drawn or its group first opened, so a reader
  // who folds the group afterwards is not overruled on the next append.
  const openRunGroup = inputs.openRunGroup;
  const settledCursor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (messageAnchorCursor === undefined || settledCursor.current === messageAnchorCursor) {
      return;
    }
    if (landingRowKey !== undefined) {
      settledCursor.current = messageAnchorCursor;
      return;
    }
    if (foldedRunGroup !== undefined) {
      settledCursor.current = messageAnchorCursor;
      openRunGroup(foldedRunGroup.key);
    }
  }, [landingRowKey, foldedRunGroup, messageAnchorCursor, openRunGroup]);

  return { landingRowKey, readBack };
}

/**
 * Asks for a stretch past the window while the linked message is not in the log: after it while
 * the tail was let go, then before it. A cursor carries no order, so the newer side is read
 * first, where a link most often points. Each landed stretch re-renders with the grown log, so
 * this reads stretch by stretch and stops on its own: at the message, at both ends of history, or
 * at a failed read, which the line at the top offers to try again before the window. Once the
 * message is found the reading back is over for that link, so a row that later leaves the log is
 * not chased back. Answers how the reading back stands, or `undefined` when none is owed.
 */
function useReadBackToMessage(
  messageAnchorCursor: string | undefined,
  eventId: string | undefined,
  history: TranscriptHistory | undefined,
): MessageReadBack | undefined {
  const [reachedCursor, setReachedCursor] = useState<string | undefined>(undefined);
  // Keyed on the history object, which is new after every stretch, so a stretch that lands
  // without the message asks for the next even when no flag reads differently.
  useEffect(() => {
    if (messageAnchorCursor === undefined || reachedCursor === messageAnchorCursor) {
      return;
    }
    if (eventId !== undefined) {
      setReachedCursor(messageAnchorCursor);
      return;
    }
    if (history === undefined) {
      return;
    }
    const { earlier, later } = history.state;
    if (later.hasMore) {
      if (!later.isReading && !later.hasFailed) {
        history.readStretch("tail");
      }
      return;
    }
    if (earlier.hasMore && !earlier.isReading && !earlier.hasFailed) {
      history.readStretch("head");
    }
  }, [messageAnchorCursor, reachedCursor, eventId, history]);
  if (
    messageAnchorCursor === undefined ||
    reachedCursor === messageAnchorCursor ||
    eventId !== undefined ||
    history === undefined
  ) {
    return undefined;
  }
  // A failed read leaves the reading back owed: asking for the stretch again resumes it.
  const isEdgeExhausted = (edge: HistoryEdgeState): boolean => !edge.hasMore && !edge.hasFailed;
  return isEdgeExhausted(history.state.earlier) && isEdgeExhausted(history.state.later)
    ? "not-in-history"
    : "reading-back";
}

/**
 * The run group a row is hidden in, or `undefined` when the window draws the row, it is in no run
 * group, or it is not in the log.
 */
function runGroupFoldingAway(
  rowKey: string | undefined,
  unfurledWindow: TranscriptWindowModel,
  transcriptWindow: TranscriptWindowModel,
): RunGroup | undefined {
  if (rowKey === undefined || transcriptWindow.rowsByKey.has(rowKey)) {
    return undefined;
  }
  const runGroupKey = unfurledWindow.runGroupKeyByRowId.get(rowKey);
  return runGroupKey === undefined
    ? undefined
    : transcriptWindow.runGroupByHeaderKey.get(runGroupKey);
}

/**
 * The drawn row a link to `rowKey` lands on: that row when the feed draws it, else the next drawn
 * row after it in log order, else the one before it. `undefined` while the fold hides the row or
 * the window does not hold it. The walk runs only for a row the feed draws nothing for.
 */
function landingRowKeyFor(
  rowKey: string | undefined,
  unfurledWindow: TranscriptWindowModel,
  transcriptWindow: TranscriptWindowModel,
  drawsRow: (row: ProjectedTranscriptRow) => boolean,
): string | undefined {
  // `rowsByKey` still joins a row the feed draws nothing for, so it says only what the fold kept.
  const row = rowKey === undefined ? undefined : transcriptWindow.rowsByKey.get(rowKey);
  if (row === undefined) {
    return undefined;
  }
  if (drawsRow(row)) {
    return row.id;
  }
  const isOnScreen = (candidate: ProjectedTranscriptRow): boolean =>
    transcriptWindow.rowsByKey.has(candidate.id) && drawsRow(candidate);
  const logRows = unfurledWindow.rows;
  const position = logRows.findIndex((candidate) => candidate.id === row.id);
  for (let after = position + 1; after < logRows.length; after += 1) {
    const candidate = logRows[after];
    if (candidate !== undefined && isOnScreen(candidate)) {
      return candidate.id;
    }
  }
  for (let before = position - 1; before >= 0; before -= 1) {
    const candidate = logRows[before];
    if (candidate !== undefined && isOnScreen(candidate)) {
      return candidate.id;
    }
  }
  return undefined;
}

function selectOldestEvent(state: SessionStoreState): ProjectedSessionEvent | undefined {
  return state.transcript[0];
}

// Only past a let-go tail, so a streamed append to a live tail changes nothing.
function selectNewestDetachedEvent(state: SessionStoreState): ProjectedSessionEvent | undefined {
  return state.transcriptTail.following === "detached" ? state.transcript.at(-1) : undefined;
}
