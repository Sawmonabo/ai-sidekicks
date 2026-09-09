// The endurance tier's heap-snapshot reader.
//
// `heap-instrument.ts` beside this answers "how big is the renderer heap"; this
// answers the question a flat-heap gate asks only when it fails — "what is holding
// it". A total figure says a run leaked; it does not say which constructor grew, and
// bisecting a thirty-minute replay by hand to find out is the cost this module
// removes.
//
// TWO ADOPTed TOOLS, EACH DOING THE HALF IT IS FOR, per `Spec-023 §Console Libraries`.
// `devtools-protocol` types the CDP traffic: `HeapProfiler.takeHeapSnapshot` and the
// chunk event it streams back are hand-spelled strings on Playwright's `CDPSession`,
// so a mistyped parameter is a silent no-op today — the snapshot simply arrives
// without the retainer data the analysis needs. `memlab` parses the snapshot file.
// Parsing a V8 heap snapshot is a format with an index-encoded node table and a
// string table behind it, and an own parser for it would be several hundred lines of
// code whose only consumer is a failure path.
//
// SNAPSHOTS END UP IN A FILE AND NOT IN A BUFFER THE CALLER HOLDS. A snapshot of a
// 250 MB heap is itself larger than the heap it describes, so a reader that returned
// one as a string would make the instrument the leak. The chunks stream to disk; the
// reader hands memlab a path; the caller removes the file.
//
// AND THE PEAK WHILE IT IS BEING WRITTEN IS UNCHANGED BY THE QUEUE BELOW, which
// RELOCATES those bytes rather than removing them. `write` answers `false` once the
// kernel buffer is full and holds the rest in memory until the stream drains; `onChunk`
// is synchronous and CDP delivers its chunks in a burst, so while the first write is
// parked on `drain` every later chunk is appended to the chain as a closure holding its
// own `event.chunk` string, plus one promise apiece. For a 250 MB heap the resident
// peak is the same 250 MB either way, and no fix is available at this seam:
// `HeapProfiler.addHeapSnapshotChunk` has no flow control and the session cannot be
// paused mid-snapshot.
//
// WHAT THE QUEUE DOES BUY IS ORDER AND A PLACE TO RAISE FROM, which is why it is here.
// CDP emits faster than a disk takes, and two unordered waiters interleave the file into
// something memlab cannot parse; one chain also gives the stream's error exactly one
// wait to be raced against, which the paragraph below is about.
//
// A STREAM ERROR IS RAISED, NOT LEFT TO ESCAPE. A `WriteStream` with no `error`
// listener THROWS the event, so an unwritable path used to surface as an uncaught
// exception from inside a `finally` — a report about the instrument, arriving where a
// reader is looking for a report about the console. The failure is raced against both
// waits instead, so it arrives as this function rejecting with the reason.

import { createWriteStream } from "node:fs";
import { once } from "node:events";

import type { CDPSession } from "@playwright/test";
import type { Protocol } from "devtools-protocol";
import { getHeapFromFile } from "memlab";

/**
 * What one constructor was holding when the snapshot was taken.
 *
 * Retained size and not shallow size: the question a leak asks is what dies when this
 * object dies, and shallow size answers a different one.
 */
export interface RetainedConstructorReading {
  readonly constructorName: string;
  readonly instanceCount: number;
  readonly retainedByteCount: number;
}

/**
 * Take a heap snapshot over CDP and write it to `snapshotPath`.
 *
 * `treatGlobalObjectsAsRoots` is set because the reading is about what the page
 * retains, and `captureNumericValue` is left off because numeric values multiply the
 * snapshot's size for a reading no constructor-level analysis uses. Both are typed
 * from the protocol rather than spelled into an untyped object literal, which is the
 * point of the dependency.
 */
export async function captureHeapSnapshot(
  cdpSession: CDPSession,
  snapshotPath: string,
): Promise<void> {
  const snapshotFile = createWriteStream(snapshotPath, { encoding: "utf8" });
  // `once` on `"error"` FULFILS with the event's arguments rather than rejecting, so
  // this is simply pending for the whole of an ordinary run — never an unhandled
  // rejection, and never a listener that has to be removed.
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
    // The queue settles before the end, and the end is reached whether it settled or
    // threw: a stream left un-ended holds a descriptor for the rest of the run, and a
    // truncated snapshot reaches memlab as a parse failure that says nothing about
    // the write error underneath it.
    try {
      await queuedWrites;
    } finally {
      snapshotFile.end();
      await Promise.race([once(snapshotFile, "close"), raiseWhenTheStreamFails()]);
    }
  }
}

/**
 * Read a written snapshot and report what the named constructors retain.
 *
 * The caller names the constructors rather than receiving every one of them: a
 * snapshot holds tens of thousands, and a reading a case cannot state an expectation
 * over is a dump rather than an assertion. A named constructor with no instances
 * reports zero rather than being absent, so a case asserting "this is gone" reads a
 * row rather than an absence.
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
