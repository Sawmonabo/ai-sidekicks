// The endurance tier's heap-snapshot reader: `instrument.ts` answers how big the renderer
// heap is, this answers what is holding it, so a leaking run need not be bisected by hand.
//
// `devtools-protocol` types the CDP traffic, whose `HeapProfiler.takeHeapSnapshot` parameters
// are bare strings on Playwright's `CDPSession`; a mistyped one is a silent no-op that yields a
// snapshot without the retainer data. `memlab` parses the snapshot, a format with an
// index-encoded node table and a string table that an own parser would need hundreds of lines
// to cover, for a failure path only.
//
// Snapshots go to a file, not a buffer the caller holds: a snapshot of a 250 MB heap is larger
// than the heap, so returning one as a string would make the instrument the leak.
//
// The write queue relocates those bytes rather than removing them. `write` answers `false` once
// the kernel buffer is full, `onChunk` is synchronous, and CDP delivers chunks in a burst, so
// later chunks wait in the chain as closures holding their own strings. The resident peak is the
// same either way, and the seam offers no fix: `HeapProfiler.addHeapSnapshotChunk` has no flow
// control and the session cannot be paused mid-snapshot. The queue buys order (two unordered
// waiters would interleave the file into something memlab cannot parse) and one wait for the
// stream's error to race against.
//
// A `WriteStream` with no `error` listener throws the event, so an unwritable path would surface
// as an uncaught exception from inside a `finally`. The failure is raced against both waits
// instead, so this function rejects with the reason.

import { createWriteStream } from "node:fs";
import { once } from "node:events";

import type { CDPSession } from "@playwright/test";
import type { Protocol } from "devtools-protocol";
import { getHeapFromFile } from "memlab";

/**
 * What one constructor was holding when the snapshot was taken.
 *
 * Retained size, not shallow size: a leak asks what dies when this object dies.
 */
export interface RetainedConstructorReading {
  readonly constructorName: string;
  readonly instanceCount: number;
  readonly retainedByteCount: number;
}

/**
 * Takes a heap snapshot over CDP and writes it to `snapshotPath`.
 *
 * `treatGlobalObjectsAsRoots` is set because the reading is about what the page retains;
 * `captureNumericValue` is off because numeric values multiply the snapshot's size for no
 * constructor-level use.
 */
export async function captureHeapSnapshot(
  cdpSession: CDPSession,
  snapshotPath: string,
): Promise<void> {
  const snapshotFile = createWriteStream(snapshotPath, { encoding: "utf8" });
  // `once` on "error" fulfills rather than rejecting, so this stays pending for an ordinary
  // run: never an unhandled rejection, and no listener to remove.
  const streamFailure = once(snapshotFile, "error");
  const raiseWhenTheStreamFails = async (): Promise<never> => {
    const [failure] = await streamFailure;
    throw failure instanceof Error ? failure : new Error(String(failure));
  };

  let queuedWrites: Promise<void> = Promise.resolve();
  const onChunk = (event: Protocol.HeapProfiler.AddHeapSnapshotChunkEvent): void => {
    queuedWrites = queuedWrites.then(async () => {
      if (!snapshotFile.write(event.chunk)) {
        await Promise.race([once(snapshotFile, "drain"), raiseWhenTheStreamFails()]);
      }
    });
  };

  cdpSession.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
  try {
    const request: Protocol.HeapProfiler.TakeHeapSnapshotRequest = {
      reportProgress: false,
      treatGlobalObjectsAsRoots: true,
      captureNumericValue: false,
    };
    await cdpSession.send("HeapProfiler.takeHeapSnapshot", request);
  } finally {
    cdpSession.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
    // The queue settles before the end, and the end is reached even if it threw: an un-ended
    // stream holds a descriptor, and a truncated snapshot reaches memlab as a parse failure
    // that hides the write error.
    try {
      await queuedWrites;
    } finally {
      snapshotFile.end();
      await Promise.race([once(snapshotFile, "close"), raiseWhenTheStreamFails()]);
    }
  }
}

/**
 * Reads a written snapshot and reports what the named constructors retain.
 *
 * The caller names them because a snapshot holds tens of thousands. A named constructor with
 * no instances reports zero rather than being absent.
 */
export async function retainedByConstructor(
  snapshotPath: string,
  constructorNames: readonly string[],
): Promise<readonly RetainedConstructorReading[]> {
  const snapshot = await getHeapFromFile(snapshotPath);
  const wanted = new Set(constructorNames);
  const instanceCountByName = new Map<string, number>();
  const retainedByteCountByName = new Map<string, number>();
  snapshot.nodes.forEach((node) => {
    if (!wanted.has(node.name)) {
      return true;
    }
    instanceCountByName.set(node.name, (instanceCountByName.get(node.name) ?? 0) + 1);
    retainedByteCountByName.set(
      node.name,
      (retainedByteCountByName.get(node.name) ?? 0) + node.retainedSize,
    );
    return true;
  });
  return constructorNames.map((constructorName) => ({
    constructorName,
    instanceCount: instanceCountByName.get(constructorName) ?? 0,
    retainedByteCount: retainedByteCountByName.get(constructorName) ?? 0,
  }));
}
