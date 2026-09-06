// Retry: every leg of the trio is replayed rather than restarted, and exactly one refusal
// is terminal for the stream.
//
// The client is driven directly against the scripted growth port beside it, which records
// every request: only a collaborator on the other side of the seam can witness that a
// retry re-sent ONE sequence number carrying identical bytes, which is the whole
// difference between a replay and a re-upload.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { consoleTripwires } from "../../core/tripwires.js";
import {
  SMALL_SOURCE,
  ScriptedGrowthPort,
  clientOver,
} from "./attachment-ingest-scripted-port.test-support.js";
import { INGEST_CAPACITY_EXHAUSTED_CODE, INGEST_STREAM_INVALID_CODE } from "./attachment-policy.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";

beforeEach(() => {
  consoleTripwires.setThrowOnReport(false);
  consoleTripwires.reset();
});

afterEach(() => {
  consoleTripwires.reset();
  consoleTripwires.setThrowOnReport(import.meta.env.DEV);
});

describe("ingest client — retry replays, and one refusal restarts", () => {
  it("re-sends the same chunk after a lost response", async () => {
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    port.refuseChunksWith("wire-unregistered");
    client.attach(SMALL_SOURCE);
    await crossMacrotaskBoundary();
    expect(client.snapshot[0]?.disposition).toBe("retry-in-place");

    port.refuseChunksWith(undefined);
    client.retry("attachment-1");
    await crossMacrotaskBoundary();

    // Two chunk calls at the SAME sequence number carrying the SAME bytes: the replay,
    // not a restart. That pair is exactly what the daemon acknowledges without
    // re-appending, which is what makes this the cheap answer to a lost response.
    expect(port.chunkCalls.map((call) => call.sequenceNumber)).toStrictEqual([0, 0]);
    expect(port.chunkCalls[0]?.chunk).toBe(port.chunkCalls[1]?.chunk);
    expect(client.snapshot[0]?.state).toBe("complete");
  });

  it("drops the ledger only for the terminal stream refusal", async () => {
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    port.refuseChunksWith(INGEST_STREAM_INVALID_CODE);
    client.attach(SMALL_SOURCE);
    await crossMacrotaskBoundary();

    expect(client.snapshot[0]?.disposition).toBe("restart");
    expect(client.snapshot[0]?.refusal?.code).toBe(INGEST_STREAM_INVALID_CODE);
  });

  it("negative control: the capacity refusal keeps its stream and waits", async () => {
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    port.refuseChunksWith(INGEST_CAPACITY_EXHAUSTED_CODE);
    client.attach(SMALL_SOURCE);
    await crossMacrotaskBoundary();

    expect(client.snapshot[0]?.disposition).toBe("wait-and-retry");
    expect(client.snapshot[0]?.ingestId).toBe("ingest-1");
  });

  it("replays a lost completion rather than re-uploading", async () => {
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    port.refuseCompletionWith("wire-unregistered");
    client.attach(SMALL_SOURCE);
    await crossMacrotaskBoundary();
    expect(client.snapshot[0]?.state).toBe("refused");

    port.refuseCompletionWith(undefined);
    client.retry("attachment-1");
    await crossMacrotaskBoundary();

    // One chunk sent in total: the retry resumed at the end of the ledger and went
    // straight back to completion.
    expect(port.chunkCalls).toHaveLength(1);
    expect(client.snapshot[0]?.state).toBe("complete");
  });
});
