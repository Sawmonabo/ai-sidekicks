// The row a link to a message lands on. The link names the message by its event cursor, which the
// store's log carries on every event, streamed or read back. A message older than the window is
// reached by paging back through the feed's walk until the log holds it; a message inside a
// finished run group is opened out of its fold first, once, so the row is drawn rather than
// hidden under a header.

import { useEffect, useMemo, useRef } from "react";

import { useSessionStore } from "#renderer/store/session/hooks/useOpenSessionStore.js";
import { type ProjectedSessionEvent } from "#renderer/store/session/entities/entities.js";
import { type SessionStore } from "#renderer/store/session/session-store.js";
import { type SessionStoreState } from "#renderer/store/session/state.js";
import { readRunGroupKey, type RunGroup } from "../../run-groups/run-groups.js";
import { type EarlierHistoryPaging } from "../../history/hooks/useEarlierHistory.js";
import { type TranscriptWindowModel } from "../../window/transcript-window.js";
import { type RunGroupDisclosure } from "../run-group-fold.js";

/** What the landing row is looked up in. */
export interface MessageAnchorRowKeyInputs {
  readonly sessionStore: SessionStore;
  /** The cursor of the message to land on, or `undefined` for an ordinary open. */
  readonly messageAnchorCursor: string | undefined;
  /** The backward walk that reaches a message older than the window, or none to page with. */
  readonly earlierHistory: EarlierHistoryPaging | undefined;
  /** Every row of every run group, before any fold. */
  readonly unfurledWindow: TranscriptWindowModel;
  /** The window the viewport draws: folded by run group. */
  readonly transcriptWindow: TranscriptWindowModel;
  readonly runGroupDisclosure: RunGroupDisclosure;
}

/**
 * The key of the drawn row the message cursor names, or `undefined` while there is none: no
 * cursor, a cursor the log does not hold (yet, or at all), or an event that draws no row. While
 * the log lacks it, this pages back one page per render until the message arrives, history
 * starts or a page is refused. Nothing stands in for a missing row, so the transcript opens as
 * it would with no link.
 */
export function useMessageAnchorRowKey(inputs: MessageAnchorRowKeyInputs): string | undefined {
  const { sessionStore, messageAnchorCursor, unfurledWindow, transcriptWindow } = inputs;
  // The log's oldest event moves when the log is first read, when a page lands and when the cap
  // lets rows go: the only times an older message can arrive or leave. Keyed on it, the lookup
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
  usePageBackToMessage(messageAnchorCursor, eventId, inputs.earlierHistory);
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

  return eventId !== undefined && transcriptWindow.rowsByKey.has(eventId) ? eventId : undefined;
}

/**
 * Asks for the page before the window while the linked message is not in the log. Each landed
 * page re-renders with the grown log, so this walks page by page and stops on its own: at the
 * message, at the start of history (`canLoadEarlier` false), or at a refusal, which the head
 * control shows and offers to retry. Once the message is found the walk is over for that link,
 * so a row the window cap later lets go of is not chased back.
 */
function usePageBackToMessage(
  messageAnchorCursor: string | undefined,
  eventId: string | undefined,
  earlierHistory: EarlierHistoryPaging | undefined,
): void {
  const reachedCursor = useRef<string | undefined>(undefined);
  // Keyed on the walk's state object, which is new after every page, so a page that lands
  // without the message asks for the next even when no flag reads differently.
  useEffect(() => {
    if (messageAnchorCursor === undefined || reachedCursor.current === messageAnchorCursor) {
      return;
    }
    if (eventId !== undefined) {
      reachedCursor.current = messageAnchorCursor;
      return;
    }
    if (earlierHistory?.canLoadEarlier === true && earlierHistory.refusal === undefined) {
      earlierHistory.loadEarlier();
    }
  }, [messageAnchorCursor, eventId, earlierHistory]);
}

/**
 * The finished run group whose fold hides the row, or `undefined` when the row is drawn, is in no
 * folded group, or is not in the log. The fold keeps a group's terminal row, so only its other
 * rows can be hidden.
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

function selectOldestEvent(state: SessionStoreState): ProjectedSessionEvent | undefined {
  return state.transcript[0];
}
