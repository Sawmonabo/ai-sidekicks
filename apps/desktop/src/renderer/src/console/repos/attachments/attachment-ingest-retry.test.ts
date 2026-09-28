// Retry: a refusal that leaves the stream open resumes it, and an unusable acknowledgement
// begins it again.
//
// The client is driven directly against the scripted ingest port beside it, which records
// every request: only a collaborator on the other side of the seam can witness whether a
// retry re-opened the stream or went on from the offset it stood at.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ATTACHMENT_CHUNK_BYTE_CAP } from "../../core/index.js";
import { consoleTripwires } from "../../core/tripwires.js";
import {
  SMALL_SOURCE,
  ScriptedIngestPort,
  clientOver,
  movableSourceOver,
} from "./attachment-ingest-scripted-port.test-support.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";

beforeEach(() => {
  consoleTripwires.setThrowOnReport(false);
  consoleTripwires.reset();
});

afterEach(() => {
  consoleTripwires.reset();
  consoleTripwires.setThrowOnReport(import.meta.env.DEV);
});

describe("ingest client — retry resumes what the file made unreadable", () => {
  it("resumes the same stream at the same offset once the file is readable again", async () => {
    const port = new ScriptedIngestPort();
    const client = clientOver(port);
    // Three chunks, and the file goes after the first read: chunk 0 is acknowledged, then
    // chunk 1 cannot be read.
    const byteLength = ATTACHMENT_CHUNK_BYTE_CAP * 2 + 7;
    const movable = movableSourceOver("attachment-1", "notes.md", byteLength, 1);
    client.attach(movable.source);
    await crossMacrotaskBoundary();
    expect(client.snapshot[0]?.state).toBe("refused");
    expect(client.snapshot[0]?.disposition).toBe("retry-in-place");
    expect(client.snapshot[0]?.receivedBytes).toBe(ATTACHMENT_CHUNK_BYTE_CAP);
    expect(port.chunkCalls.map((call) => call.sequenceNumber)).toStrictEqual([0]);

    movable.restoreFile();
    client.retry("attachment-1");
    await crossMacrotaskBoundary();

    // No second open, and the first chunk after the retry is sequence 1: the retry went on
    // from the offset the daemon acknowledged rather than beginning again.
    expect(port.initCalls).toHaveLength(1);
    expect(port.chunkCalls.map((call) => call.sequenceNumber)).toStrictEqual([0, 1, 2]);
    expect(client.snapshot[0]?.state).toBe("complete");
  });

  it("begins again from the first byte when the acknowledgement was unusable", async () => {
    const port = new ScriptedIngestPort();
    const client = clientOver(port);
    port.acknowledgeChunksWith({ ingestId: "ingest-1", receivedBytes: 0 });
    client.attach(SMALL_SOURCE);
    await crossMacrotaskBoundary();
    expect(client.snapshot[0]?.disposition).toBe("restart");

    port.acknowledgeChunksWith(undefined);
    client.retry("attachment-1");
    await crossMacrotaskBoundary();

    expect(port.initCalls).toHaveLength(2);
    expect(client.snapshot[0]?.ingestId).toBe("ingest-2");
    expect(client.snapshot[0]?.state).toBe("complete");
  });
});
