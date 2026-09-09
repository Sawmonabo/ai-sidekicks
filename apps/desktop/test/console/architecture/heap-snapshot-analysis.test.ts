// What the snapshot writer promises: every chunk reaches the file whole and in order,
// and a stream that cannot be written to says so through this call rather than past it.
//
// ORDER AND COMPLETENESS, DELIBERATELY NOT PEAK MEMORY. The writer's queue relocates the
// buffered bytes rather than removing them — `heap-snapshot-analysis.ts`' own header says
// why the seam admits no fix — so there is no memory claim here to hold it to, and a case
// that asserted one would be asserting something the subject does not do.
//
// The CDP session is a double and the write stream is REAL, which is the split the two
// surviving claims ask for: both are properties of the stream half, and a doubled stream
// would answer `true` to every `write` and prove nothing about either.
//
// IN THIS TIER RATHER THAN BESIDE ITS SUBJECT, on `bounded-cleanup.test.ts`' and
// `launch-deadline.test.ts`' precedent — the console's own scaffolding, driven with
// doubles, in the one tier a person runs before pushing. Under
// `test/console/endurance/**` its two cases ran only when someone opted into the
// thirty-minute tier by name, and this file launches no window and needs no built bundle.

import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CDPSession } from "@playwright/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { captureHeapSnapshot } from "../endurance/heap-snapshot-analysis.js";

/**
 * A chunk large enough that a few of them cross the stream's high-water mark.
 *
 * 512 KiB against the 64 KiB default: the first write already fills the buffer, so
 * every chunk after it is written behind a `drain` wait rather than into memory.
 */
const CHUNK_BYTE_COUNT = 512 * 1024;

const CHUNK_COUNT = 8;

/**
 * How long the doubled command stays outstanding after its chunks are emitted.
 *
 * Load-bearing rather than padding. `takeHeapSnapshot` on a real renderer is
 * outstanding for the whole of the write, so a stream failure arrives while the
 * caller is still awaiting the command — which is the window in which an unlistened
 * `"error"` event is thrown by the emitter rather than folded into a wait. A double
 * that resolved on the same tick would close that window and test the easy half.
 */
const COMMAND_OUTSTANDING_MS = 25;

/**
 * A CDP session that emits the chunks it is given when the snapshot is requested.
 *
 * The chunks are emitted synchronously from inside `send`, which is the shape the
 * real protocol produces — a burst of events while the caller is awaiting the
 * command — and therefore the shape that fills a write buffer.
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
    // Order, not merely volume: a queue that let two waiters run would produce a
    // file of the right length whose chunks had interleaved.
    expect(written).toBe(chunks.join(""));
  });

  it("rejects with the stream's own failure rather than throwing past the caller", async () => {
    // A path whose directory does not exist. The stream raises asynchronously, while
    // the doubled command is still outstanding — and an `EventEmitter` THROWS an
    // `"error"` it has no listener for, so with no listener registered up front this
    // leaves the process rather than the call, and takes the worker with it.
    const unwritablePath = join(directory, "no-such-directory", "renderer.heapsnapshot");

    await expect(captureHeapSnapshot(emittingCdpSession(["{}"]), unwritablePath)).rejects.toThrow(
      /ENOENT/,
    );
  });
});
