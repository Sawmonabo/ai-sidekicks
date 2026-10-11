// The batching every stream of changes shares on its way to the screen: a change opens a window of
// `STREAM_WINDOW_MS`, and the window's changes go out as one frame when it closes, or at once at
// `STREAM_FRAME_MAX_CHANGES`; a throttle, not a debounce, so no change waits longer than a window.
//
// It never waits on a screen that is caught up. While the connection's outbound queue is full,
// live changes are held up to the stream's `heldChangesMax`; past that, or at once where it is
// zero, they are dropped and the next frame that fits carries the drop mark, so the screen repairs
// by cursor or by a snapshot. A drop with nothing new after it goes out as one frame with no
// changes, the drop mark and the newest dropped cursor, as soon as the queue has room. While
// catching up from the record, a change is never dropped: it waits for room, and the upstream
// hands over nothing more until it has.

import type { StreamFrame } from "@ai-sidekicks/contracts/jsonrpc/streaming";
import { STREAM_FRAME_MAX_CHANGES } from "@ai-sidekicks/contracts/jsonrpc/streaming";

/** How long the first change of a batch waits for others before its frame goes out. */
export const STREAM_WINDOW_MS = 16;

/**
 * The live changes a run stream holds while its connection's queue is full; one more and they are
 * dropped, and the screen repairs from the daemon's record.
 */
export const RUN_STREAM_HELD_CHANGES_MAX = 1024;

/** Where a batcher sends frames and how it reads its connection's queue. */
export interface StreamFrameOutlet<Change, Cursor> {
  emit(frame: StreamFrame<Change, Cursor>): void;
  isFull(): boolean;
  onceDrained(listener: () => void): () => void;
}

/** How a stream's batcher treats a full queue. */
export interface StreamFrameBatcherOptions {
  /** Whether the stream starts by catching up from the record, dropping nothing until it ends. */
  readonly isCatchingUp: boolean;
  /** The most live changes held while the queue is full; one more and they are all dropped. */
  readonly heldChangesMax: number;
}

/** One stream's batcher. */
export interface StreamFrameBatcher<Change> {
  add(change: Change): void;
  /** Ends the catch-up: its last changes go out now, and a later full queue holds or drops. */
  endCatchUp(): void;
  stop(): void;
}

/** Builds the batcher of one stream whose every change carries the cursor that resumes after it. */
export function createStreamFrameBatcher<Change extends { readonly cursor: Cursor }, Cursor>(
  outlet: StreamFrameOutlet<Change, Cursor>,
  options: StreamFrameBatcherOptions,
): StreamFrameBatcher<Change> {
  let pending: Change[] = [];
  let windowTimer: ReturnType<typeof setTimeout> | undefined;
  let newestDroppedCursor: Cursor | undefined;
  let detachDrained: (() => void) | undefined;
  let isCatchingUp = options.isCatchingUp;
  let stopped = false;

  const flushWhenDrained = (): void => {
    detachDrained ??= outlet.onceDrained(() => {
      detachDrained = undefined;
      flush();
    });
  };

  const flush = (): void => {
    if (windowTimer !== undefined) {
      clearTimeout(windowTimer);
      windowTimer = undefined;
    }
    while (!outlet.isFull()) {
      const changes = pending.splice(0, STREAM_FRAME_MAX_CHANGES);
      let frame: StreamFrame<Change, Cursor>;
      if (newestDroppedCursor === undefined) {
        if (changes.length === 0) {
          return;
        }
        frame = { changes };
      } else if (changes.length === 0) {
        frame = { changes, dropped: true, cursor: newestDroppedCursor };
      } else {
        frame = { changes, dropped: true };
      }
      newestDroppedCursor = undefined;
      detachDrained?.();
      detachDrained = undefined;
      outlet.emit(frame);
      if (pending.length === 0) {
        return;
      }
    }
    // A stored change is never dropped while catching up, and the upstream hands over no more
    // until the queue has room.
    if (!isCatchingUp && pending.length > options.heldChangesMax) {
      newestDroppedCursor = pending.at(-1)?.cursor;
      pending = [];
    }
    if (pending.length > 0 || newestDroppedCursor !== undefined) {
      flushWhenDrained();
    }
  };

  return {
    add(change: Change): void {
      if (stopped) {
        return;
      }
      pending.push(change);
      if (pending.length >= STREAM_FRAME_MAX_CHANGES) {
        flush();
      } else if (windowTimer === undefined) {
        windowTimer = setTimeout(flush, STREAM_WINDOW_MS);
      }
    },
    endCatchUp(): void {
      isCatchingUp = false;
      // The upstream ends its catch-up only while the queue has room, so the stored changes still
      // pending go out now rather than meet a full queue at the window's close.
      flush();
    },
    stop(): void {
      stopped = true;
      if (windowTimer !== undefined) {
        clearTimeout(windowTimer);
        windowTimer = undefined;
      }
      detachDrained?.();
      detachDrained = undefined;
      pending = [];
    },
  };
}
