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
// SNAPSHOTS GO TO A FILE AND NOT TO MEMORY. A snapshot of a 250 MB heap is itself
// larger than the heap it describes, so buffering one into the process that is
// measuring heap growth would make the instrument the leak. The chunks stream to
// disk; the reader hands memlab a path; the caller removes the file.

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
  const onChunk = (event: Protocol.HeapProfiler.AddHeapSnapshotChunkEvent): void => {
    snapshotFile.write(event.chunk);
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
    snapshotFile.end();
    await once(snapshotFile, "close");
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
