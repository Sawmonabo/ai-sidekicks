// What the feed hands its waiting rows: the acts on them, the drag and keys that move one within
// the stack, and the edit the draft holds. A move sends the queue's whole new order and the rows
// move when the reading reports it; a refused move puts the rows back and says the refusal's own
// words under the row. A retry the person's own prompt hook blocks again hands its words back to
// the draft, takes the row out and names the hook's words in the window's note, and a message the
// service hands back after taking it goes back to the draft too, its line said as it arrives.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { USER_MESSAGE_EVENT_TYPE } from "@ai-sidekicks/contracts/transcript/operations";

import { useAnnounce } from "#renderer/hooks/announce/useAnnounce.js";
import { useReorderDrag } from "#renderer/hooks/useReorderDrag.js";
import type { Clock } from "#renderer/lib/clock.js";
import { coerceToRefusal } from "#renderer/lib/coerce-to-refusal.js";
import { useSessionStore } from "#renderer/store/session/hooks/useOpenSessionStore.js";
import { selectTranscript } from "#renderer/store/session/selectors.js";
import type { SentMessageEntry } from "#renderer/store/session/sent-messages.js";
import type { SessionStore } from "#renderer/store/session/store.js";
import type { WindowStore } from "#renderer/store/window/store.js";
import { reorderedQueueItemIds, type QueueMoveAnchor } from "../order.js";
import { HANDED_BACK_LABEL, handedBackItemIdOf, type WaitingRow } from "../placement.js";
import type { QueueFeed } from "../reading.js";
import { blockedByHookLine, type WaitingRows } from "../waiting-rows.js";
import { useAnnounceSendFailures } from "./useAnnounceSendFailures.js";

/**
 * What `useWaitingRows` reads: the session, its queue reading, the rows the feed placed and the
 * window, whose note names a blocked retry's hook words.
 */
export interface WaitingRowsInput {
  readonly sessionStore: SessionStore;
  readonly frameStore: WindowStore;
  readonly queue: QueueFeed;
  readonly waitingRowByKey: ReadonlyMap<string, WaitingRow>;
  readonly hasActiveTurn: boolean;
  readonly isServiceUnreachable: boolean;
  readonly clock: Clock;
}

/** The waiting rows' context value for one feed, with the drag that moves them. */
export function useWaitingRows(input: WaitingRowsInput): WaitingRows {
  const {
    sessionStore,
    frameStore,
    queue,
    waitingRowByKey,
    hasActiveTurn,
    isServiceUnreachable,
    clock,
  } = input;
  const { composerRequests } = sessionStore;
  const edit = useSyncExternalStore(composerRequests.subscribe, composerRequests.editSnapshot);
  const [moveRefusal, setMoveRefusal] = useState<WaitingRows["moveRefusal"]>(undefined);
  const [lastMove, setLastMove] = useState<WaitingRows["lastMove"]>(undefined);
  // Only a row still waiting moves; a failed or unanswered one keeps its place.
  const movableKeys = useMemo(
    () =>
      [...waitingRowByKey]
        .filter(([, waitingRow]) => waitingRow.item?.state === "queued")
        .map(([rowKey]) => rowKey),
    [waitingRowByKey],
  );
  const { items, reorderItems } = queue;
  const move = useCallback(
    async (rowKey: string, anchorKey: string, side: keyof QueueMoveAnchor): Promise<boolean> => {
      const movedItemId = waitingRowByKey.get(rowKey)?.queueItemId;
      const anchorItemId = waitingRowByKey.get(anchorKey)?.queueItemId;
      if (movedItemId === undefined || anchorItemId === undefined) {
        return false;
      }
      setMoveRefusal(undefined);
      const anchor: QueueMoveAnchor =
        side === "before" ? { before: anchorItemId } : { after: anchorItemId };
      const order = reorderedQueueItemIds(items, movedItemId, anchor);
      try {
        await reorderItems(order);
      } catch (rejection) {
        const refusal = coerceToRefusal(rejection, QUEUE_REORDER_ORIGIN);
        setMoveRefusal({ rowKey, refusal });
        return false;
      }
      setLastMove({
        rowKey,
        sentence:
          `Moved message to position ${String(order.indexOf(movedItemId) + 1)} of ` +
          `${String(order.length)}.`,
      });
      return true;
    },
    [waitingRowByKey, items, reorderItems],
  );
  const drag = useReorderDrag(
    "vertical",
    movableKeys,
    (rowKey, toIndex, drawnKeys) => {
      const others = drawnKeys.filter((drawnKey) => drawnKey !== rowKey);
      const before = others[toIndex];
      const after = others.at(-1);
      const moved =
        before !== undefined
          ? move(rowKey, before, "before")
          : after === undefined
            ? Promise.resolve(false)
            : move(rowKey, after, "after");
      // A refused move brings no new order to settle on, so the rows are put back here.
      void moved.then((isMoved) => {
        if (!isMoved) {
          drag.settle();
        }
      });
    },
    clock,
    { isHandleRequired: true },
  );
  const moveRow = useCallback(
    (rowKey: string, step: -1 | 1) => {
      const neighbor = movableKeys[movableKeys.indexOf(rowKey) + step];
      if (neighbor !== undefined) {
        void move(rowKey, neighbor, step < 0 ? "before" : "after");
      }
    },
    [movableKeys, move],
  );
  useBlockedRetriesReturned(queue, sessionStore, frameStore);
  useHandedBackSendsReturned(sessionStore);
  useAnnounceSendFailures(sessionStore, queue);

  return useMemo<WaitingRows>(
    () => ({
      waitingRowByKey,
      queue,
      composerRequests,
      editingRowKey: edit?.rowKey,
      hasActiveTurn,
      isServiceUnreachable,
      drag,
      moveRow,
      moveRefusal,
      lastMove,
    }),
    [
      waitingRowByKey,
      queue,
      composerRequests,
      edit,
      hasActiveTurn,
      isServiceUnreachable,
      drag,
      moveRow,
      moveRefusal,
      lastMove,
    ],
  );
}

/** Names the reorder in a refusal, so a failure says which call failed. */
const QUEUE_REORDER_ORIGIN = "queue-reorder";

/**
 * A retry the person's own prompt hook blocked again: its words go back to the draft once, its row
 * is taken out, so the person edits them there, and the window's note names the hook's words
 * until its time runs or the next send from the composer.
 */
function useBlockedRetriesReturned(
  queue: QueueFeed,
  sessionStore: SessionStore,
  frameStore: WindowStore,
): void {
  const returned = useRef(new Set<string>());
  // The note raised last, with the sends that stood when it was raised.
  const raisedNote = useRef<{ readonly id: number; readonly sendsBefore: Set<string> }>(undefined);
  const { items, retriedItemFrom, cancelItem } = queue;
  const { sentMessages } = sessionStore;
  const sends = useSyncExternalStore(sentMessages.subscribe, sentMessages.snapshot);
  useEffect(() => {
    for (const item of items) {
      if (
        item.kind !== "message" ||
        item.state !== "notDelivered" ||
        item.notDeliveredReason.kind !== "refusedByHook" ||
        !retriedItemFrom.has(item.id) ||
        returned.current.has(item.id)
      ) {
        continue;
      }
      returned.current.add(item.id);
      void sessionStore.composerRequests.returnToDraft({ words: item.content });
      void cancelItem(item.id);
      raisedNote.current = {
        id: frameStore.showFadingNote({
          words: blockedByHookLine(item.notDeliveredReason.words),
          durationMs: BLOCKED_RETRY_NOTE_MS,
        }),
        sendsBefore: sendStamps(sentMessages.snapshot()),
      };
    }
  }, [items, retriedItemFrom, cancelItem, sessionStore, sentMessages, frameStore]);
  useEffect(() => {
    const note = raisedNote.current;
    if (note === undefined) {
      return;
    }
    for (const stamp of sendStamps(sends)) {
      if (!note.sendsBefore.has(stamp)) {
        raisedNote.current = undefined;
        frameStore.takeFadingNote(note.id);
        return;
      }
    }
  }, [sends, frameStore]);
}

/** How long the note naming a blocked retry's hook words stays, in milliseconds. */
const BLOCKED_RETRY_NOTE_MS = 10_000;

/**
 * Each press or edit of a message from the composer: a press is a new key, and an edit sends again
 * under its row's key at a new time, while a send's settling keeps both.
 */
function sendStamps(entries: readonly SentMessageEntry[]): Set<string> {
  return new Set(
    entries.flatMap((entry) => (entry.kind === "sent" ? [`${entry.key} ${entry.sentAt}`] : [])),
  );
}

/**
 * A message the service hands back after taking it, a turn too long for the context window: its
 * words go back to the draft once, when the failure arrives, and its line is said. Failures the log
 * already held when the feed mounted were handed back then, so they hand nothing back again.
 */
function useHandedBackSendsReturned(sessionStore: SessionStore): void {
  const announce = useAnnounce();
  const transcript = useSessionStore(sessionStore, selectTranscript);
  const seen = useRef<Set<string> | undefined>(undefined);
  useEffect(() => {
    const isFirstRead = seen.current === undefined;
    const held = (seen.current ??= new Set<string>());
    for (const event of transcript) {
      const queueItemId = handedBackItemIdOf(event);
      if (queueItemId === undefined || held.has(event.id)) {
        continue;
      }
      held.add(event.id);
      if (!isFirstRead) {
        announce(HANDED_BACK_LABEL, "assertive");
      }
      const message = isFirstRead
        ? undefined
        : transcript.find(
            (candidate) =>
              candidate.kind === USER_MESSAGE_EVENT_TYPE &&
              candidate.payload?.["queueItemId"] === queueItemId,
          );
      const words = message?.payload?.["message"];
      if (typeof words === "string") {
        void sessionStore.composerRequests.returnToDraft({ words });
      }
    }
  }, [transcript, sessionStore, announce]);
}
