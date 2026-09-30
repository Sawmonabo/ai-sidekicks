// What the snapshot writer promises: every chunk reaches the file whole and in order, and a
// stream that cannot be written to says so through the call, not past it.
//
// Order and completeness only, not peak memory: the writer's queue relocates the buffered bytes
// rather than removing them (see `tests/endurance/heap-snapshot-analysis.ts`). The CDP session is
// a double and the write stream is real, since a doubled stream would answer `true` to every
// `write` and prove nothing. It lives here so it runs in the `main-unit` project; it launches no
// window and needs no built bundle.

import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CDPSession } from "@playwright/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { captureHeapSnapshot } from "../endurance/heap-snapshot-analysis.js";

/**
 * A chunk large enough that a few of them cross the stream's high-water mark: 512 KiB against
 * the 64 KiB default, so later chunks are written behind a `drain` wait.
 */
const CHUNK_BYTE_COUNT = 512 * 1024;

const CHUNK_COUNT = 8;

/**
 * How long the doubled command stays outstanding after its chunks are emitted. A real
 * `takeHeapSnapshot` is outstanding for the whole write, so a stream failure arrives while the
 * caller awaits; a double resolving on the same tick would skip the window in which an
 * unlistened `"error"` is thrown by the emitter.
 */
const COMMAND_OUTSTANDING_MS = 25;

/**
 * A CDP session that emits the chunks it is given when the snapshot is requested, synchronously
 * from inside `send` as the real protocol does, which is what fills a write buffer.
 */
function emittingCdpSession(chunks: readonly string[]): CDPSession {
  const events = new EventEmitter();
  return {
    on(eventName: string, listener: (...eventArguments: unknown[]) => void) {
      events.on(eventName, listener);
      return this;
    },
    off(eventName: string, listener: (...eventArguments: unknown[]) => void) {
      events.off(eventName, listener);
      return this;
    },
    send(): Promise<unknown> {
      for (const chunk of chunks) {
        events.emit("HeapProfiler.addHeapSnapshotChunk", { chunk });
      }
      return new Promise((resolve) => {
        setTimeout(resolve, COMMAND_OUTSTANDING_MS);
      });
    },
  } as unknown as CDPSession;
}

describe("writing a heap snapshot to a file", () => {
  let directory = "";
  let snapshotPath = "";

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "sidekicks-heap-snapshot-"));
    snapshotPath = join(directory, "renderer.heapsnapshot");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("writes every chunk, in order, across many buffer fills", async () => {
    const chunks = Array.from({ length: CHUNK_COUNT }, (_unused, index) =>
      String(index % 10).repeat(CHUNK_BYTE_COUNT),
    );

    await captureHeapSnapshot(emittingCdpSession(chunks), snapshotPath);

    const written = await readFile(snapshotPath, "utf8");
    expect(written).toHaveLength(CHUNK_BYTE_COUNT * CHUNK_COUNT);
    // Order, not merely volume: a queue letting two waiters run would interleave the chunks.
    expect(written).toBe(chunks.join(""));
  });

  it("rejects with the stream's own failure rather than throwing past the caller", async () => {
    // A path whose directory does not exist. The stream raises while the doubled command is
    // outstanding, and an `EventEmitter` throws an `"error"` with no listener, so without one
    // registered up front it would leave the process instead of the call.
    const unwritablePath = join(directory, "no-such-directory", "renderer.heapsnapshot");

    await expect(captureHeapSnapshot(emittingCdpSession(["{}"]), unwritablePath)).rejects.toThrow(
      /ENOENT/,
    );
  });
});
