// Retry: a refusal that leaves the stream open resumes it, and an unusable acknowledgement
// begins it again. The scripted port records every request, so the test can see whether a retry
// re-opened the stream or went on from its offset.

import { ARTIFACT_CHUNK_MAX_BYTES } from "@ai-sidekicks/contracts";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { windowTripwires } from "@renderer/lib/tripwires.js";
import {
  SMALL_SOURCE,
  ScriptedIngestPort,
  clientOver,
  movableSourceOver,
} from "@test/helpers/scripted-ingest-port.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";

beforeEach(() => {
  windowTripwires.setThrowOnReport(false);
  windowTripwires.reset();
});

afterEach(() => {
  windowTripwires.reset();
  windowTripwires.setThrowOnReport(import.meta.env.DEV);
});

describe("ingest client — retry resumes what the file made unreadable", () => {
  it("resumes the same stream at the same offset once the file is readable again", async () => {
    const port = new ScriptedIngestPort();
    const client = clientOver(port);
    // Three chunks; the file goes after the first read, so chunk 1 cannot be read.
    const byteLength = ARTIFACT_CHUNK_MAX_BYTES * 2 + 7;
    const movable = movableSourceOver("attachment-1", "notes.md", byteLength, 1);
    client.attach(movable.source);
    await crossMacrotaskBoundary();
    expect(client.snapshot[0]?.state).toBe("refused");
    expect(client.snapshot[0]?.disposition).toBe("retry-in-place");
    expect(client.snapshot[0]?.receivedBytes).toBe(ARTIFACT_CHUNK_MAX_BYTES);
    expect(port.chunkCalls.map((call) => call.sequenceNumber)).toStrictEqual([0]);

    movable.restoreFile();
    client.retry("attachment-1");
    await crossMacrotaskBoundary();

    // No second open, and the first chunk after the retry is sequence 1.
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
