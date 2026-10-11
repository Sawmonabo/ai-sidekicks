// A run stream's batcher on a connection whose queue the test fills and drains: live changes are
// held up to the run streams' bound and dropped past it, and the screen then gets one frame with
// the drop mark and the newest cursor.

import { describe, expect, it } from "vitest";

import type { StreamFrame } from "@ai-sidekicks/contracts/jsonrpc/streaming";

import {
  createStreamFrameBatcher,
  RUN_STREAM_HELD_CHANGES_MAX,
  type StreamFrameBatcher,
} from "../stream-frame-batcher.js";

interface CursorChange {
  readonly cursor: string;
}

interface FilledConnection {
  readonly batcher: StreamFrameBatcher<CursorChange>;
  readonly frames: StreamFrame<CursorChange, string>[];
  /** Gives the connection room again and tells the batcher. */
  drain(): void;
}

// A batcher on a connection whose queue is full until `drain`.
function batcherOnFullConnection(): FilledConnection {
  const frames: StreamFrame<CursorChange, string>[] = [];
  let isFull = true;
  let drained: (() => void) | undefined;
  const batcher = createStreamFrameBatcher<CursorChange, string>(
    {
      emit: (frame) => {
        frames.push(frame);
      },
      isFull: () => isFull,
      onceDrained: (listener) => {
        drained = listener;
        return () => {
          drained = undefined;
        };
      },
    },
    { isCatchingUp: false, heldChangesMax: RUN_STREAM_HELD_CHANGES_MAX },
  );
  return {
    batcher,
    frames,
    drain: () => {
      isFull = false;
      drained?.();
    },
  };
}

function changesUpTo(count: number): CursorChange[] {
  return Array.from({ length: count }, (_, index) => ({ cursor: `cursor-${String(index + 1)}` }));
}

describe("a run stream's batcher", () => {
  // Mutation: dropping at the bound rather than past it loses the held changes of a screen that
  // fell exactly that far behind.
  it("holds every change up to the bound for a full connection, and sends them once it drains", () => {
    const connection = batcherOnFullConnection();

    for (const change of changesUpTo(RUN_STREAM_HELD_CHANGES_MAX)) {
      connection.batcher.add(change);
    }
    connection.drain();

    expect(connection.frames.every((frame) => frame.dropped === undefined)).toBe(true);
    expect(connection.frames.flatMap((frame) => frame.changes)).toEqual(
      changesUpTo(RUN_STREAM_HELD_CHANGES_MAX),
    );
    connection.batcher.stop();
  });

  // Mutation: holding without bound sends the stale changes instead of the drop mark.
  it("drops every held change one past the bound, then sends one empty frame with the drop mark and the newest cursor", () => {
    const connection = batcherOnFullConnection();
    const changes = changesUpTo(RUN_STREAM_HELD_CHANGES_MAX + 1);

    for (const change of changes) {
      connection.batcher.add(change);
    }
    expect(connection.frames).toEqual([]);
    connection.drain();

    expect(connection.frames).toEqual([
      { changes: [], dropped: true, cursor: changes.at(-1)?.cursor },
    ]);
    connection.batcher.stop();
  });
});
