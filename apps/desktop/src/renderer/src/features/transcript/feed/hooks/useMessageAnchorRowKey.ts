// The row a link to a message lands on. The link names the message by its event cursor, which the
// store's log carries on every event, streamed or read back. A message older than the window is
// reached by reading stretches back through the feed's history until the log holds it; one inside a
// finished run group is opened out of its fold first, once, so the row is drawn rather than
// hidden under a header. An event the feed draws nothing for lands on the nearest row it does draw.

import { useEffect, useMemo, useRef } from "react";

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import { useSessionStore } from "#renderer/store/session/hooks/useOpenSessionStore.js";
import { type ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { type SessionStoreState } from "#renderer/store/session/state.js";
import { readRunGroupKey, type RunGroup } from "../../runs/groups.js";
import { type TranscriptHistory } from "../../history/hooks/useTranscriptHistory.js";
import { type TranscriptWindowModel } from "../../window/transcript-window.js";
import { type RunGroupDisclosure } from "../run-group-fold.js";

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
  readonly drawsRow: (row: TranscriptEventRow) => boolean;
  readonly runGroupDisclosure: RunGroupDisclosure;
}

/**
 * The key of the drawn row the message cursor names, or `undefined` while there is none: no
 * cursor, or a cursor the log does not hold (yet, or at all). An event the feed draws nothing for
 * lands on the next drawn row after it in log order, else the one before it. While the log lacks
 * the event, this reads back one stretch at a time until it arrives, history starts or a read
 * fails. Nothing stands in for a missing row, so the transcript opens as it would with no link.
 */
export function useMessageAnchorRowKey(inputs: MessageAnchorRowKeyInputs): string | undefined {
  const { sessionStore, messageAnchorCursor, unfurledWindow, transcriptWindow, drawsRow } = inputs;
  // The log's oldest event moves when the log is first read and when a page lands: the only
  // times an older message can arrive. Keyed on it, the lookup
  // runs then and not on every streamed append, and stops at the message.
  const oldestEvent = useSessionStore(sessionStore, selectOldestEvent);
  const eventId = useMemo(
    () =>
      messageAnchorCursor === undefined || oldestEvent === undefined
        ? undefined
        : sessionStore.readable
            .getState()
            .transcript.find((event) => event.cursor === messageAnchorCursor)?.id,
    [sessionStore, messageAnchorCursor, oldestEvent],
  );
  useReadBackToMessage(messageAnchorCursor, eventId, inputs.history);
  const foldedRunGroup = useMemo(
    () => runGroupFoldingAway(eventId, unfurledWindow, transcriptWindow),
    [eventId, unfurledWindow, transcriptWindow],
  );

  // Opened once per link, so a reader who folds the group again is not overruled on the next
  // append.
  const toggleRunGroup = inputs.runGroupDisclosure.toggle;
  const openedForCursor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (foldedRunGroup === undefined || openedForCursor.current === messageAnchorCursor) {
      return;
    }
    openedForCursor.current = messageAnchorCursor;
    toggleRunGroup(foldedRunGroup);
  }, [foldedRunGroup, messageAnchorCursor, toggleRunGroup]);

  return useMemo(
    () => landingRowKeyFor(eventId, unfurledWindow, transcriptWindow, drawsRow),
    [eventId, unfurledWindow, transcriptWindow, drawsRow],
  );
}

/**
 * Asks for the stretch before the window while the linked message is not in the log. Each landed
 * stretch re-renders with the grown log, so this reads back stretch by stretch and stops on its
 * own: at the message, at the start of history, or at a failed read, which the line at the top
 * shows and offers to try again. Once the message is found the reading back is over for that
 * link, so a row that later leaves the log is not chased back.
 */
function useReadBackToMessage(
  messageAnchorCursor: string | undefined,
  eventId: string | undefined,
  history: TranscriptHistory | undefined,
): void {
  const reachedCursor = useRef<string | undefined>(undefined);
  // Keyed on the history object, which is new after every stretch, so a stretch that lands
  // without the message asks for the next even when no flag reads differently.
  useEffect(() => {
    if (messageAnchorCursor === undefined || reachedCursor.current === messageAnchorCursor) {
      return;
    }
    if (eventId !== undefined) {
      reachedCursor.current = messageAnchorCursor;
      return;
    }
    const earlier = history?.state.earlier;
    if (earlier?.hasMore === true && !earlier.isReading && !earlier.hasFailed) {
      history?.readStretch("head");
    }
  }, [messageAnchorCursor, eventId, history]);
}

/**
 * The finished run group whose fold hides the row, or `undefined` when the fold keeps the row, it
 * is in no folded group, or it is not in the log. The fold keeps a group's terminal row, so only
 * its other rows can be hidden.
 */
function runGroupFoldingAway(
  rowKey: string | undefined,
  unfurledWindow: TranscriptWindowModel,
  transcriptWindow: TranscriptWindowModel,
): RunGroup | undefined {
  if (rowKey === undefined || transcriptWindow.rowsByKey.has(rowKey)) {
    return undefined;
  }
  const row = unfurledWindow.rowsByKey.get(rowKey);
  const runId = row === undefined ? undefined : readRunGroupKey(row);
  return runId === undefined ? undefined : transcriptWindow.runGroupByHeaderKey.get(runId);
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
  drawsRow: (row: TranscriptEventRow) => boolean,
): string | undefined {
  // `rowsByKey` still joins a row the feed draws nothing for, so it says only what the fold kept.
  const row = rowKey === undefined ? undefined : transcriptWindow.rowsByKey.get(rowKey);
  if (row === undefined) {
    return undefined;
  }
  if (drawsRow(row)) {
    return row.id;
  }
  const isOnScreen = (candidate: TranscriptEventRow): boolean =>
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
