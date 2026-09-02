// Abandonment: sending stops at once, the spool is asked for back, and a call already in
// flight does not resume what a participant stopped.
//
// The client is driven directly against the scripted growth port beside it, which can be
// HELD mid-call — the only way to put an abandonment inside an await and see what the
// continuation does when it comes back to a ledger that moved underneath it.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ATTACHMENT_CHUNK_BYTE_CAP, consoleTripwires } from "../core/index.js";
import {
  SMALL_SOURCE,
  ScriptedGrowthPort,
  clientOver,
  sourceOver,
} from "./attachment-ingest-scripted-port.js";

beforeEach(() => {
  consoleTripwires.setThrowOnReport(false);
  consoleTripwires.reset();
});

afterEach(() => {
  consoleTripwires.reset();
  consoleTripwires.setThrowOnReport(import.meta.env.DEV);
});

describe("ingest client — abandonment, including mid-call", () => {
  it("stops sending and asks for the spool back", async () => {
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    port.refuseChunksWith("wire-unregistered");
    client.attach(SMALL_SOURCE);
    await new Promise((settle) => setTimeout(settle, 0));

    client.abandon("attachment-1");
    await new Promise((settle) => setTimeout(settle, 0));
    expect(client.snapshot[0]?.state).toBe("abandoned");
    expect(port.abortedIngestIds).toStrictEqual(["ingest-1"]);
  });

  it("negative control: a completed attachment is not abandonable", async () => {
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    client.attach(SMALL_SOURCE);
    await new Promise((settle) => setTimeout(settle, 0));

    client.abandon("attachment-1");
    expect(client.snapshot[0]?.state).toBe("complete");
    expect(port.abortedIngestIds).toStrictEqual([]);
  });

  it("stops a stream abandoned while its first call was in flight", async () => {
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    const gate = port.holdBegin();
    client.attach(SMALL_SOURCE);
    await new Promise((settle) => setTimeout(settle, 0));

    // Abandoned before the daemon answered: nothing in the ledger names a stream yet.
    client.abandon("attachment-1");
    expect(port.abortedIngestIds).toStrictEqual([]);
    gate.open();
    await new Promise((settle) => setTimeout(settle, 0));

    // The continuation neither resumed the abandoned entry nor sent a chunk, and it
    // asked for the spool of the stream the daemon opened underneath it — the one call
    // that could, since that id reached no entry for `abandon` to find.
    expect(client.snapshot[0]?.state).toBe("abandoned");
    expect(port.chunkCalls).toStrictEqual([]);
    expect(port.abortedIngestIds).toStrictEqual(["ingest-1"]);
  });

  it("sends no further chunk after an abandonment mid-chunk", async () => {
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    const gate = port.holdChunks();
    client.attach(sourceOver("attachment-three", "capture.bin", ATTACHMENT_CHUNK_BYTE_CAP * 2));
    await new Promise((settle) => setTimeout(settle, 0));
    expect(port.chunkCalls).toHaveLength(1);

    client.abandon("attachment-three");
    gate.open();
    await new Promise((settle) => setTimeout(settle, 0));

    // One chunk in flight, one abandonment, and no second chunk. The abort rode the
    // abandonment itself, because the stream identity was in the ledger by then.
    expect(port.chunkCalls).toHaveLength(1);
    expect(client.snapshot[0]?.state).toBe("abandoned");
    expect(port.abortedIngestIds).toStrictEqual(["ingest-1"]);
  });

  it("negative control: an unabandoned stream in flight runs to completion", async () => {
    // Without this, both cases above would pass over a client that stopped after one
    // chunk whatever the participant did.
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    const gate = port.holdChunks();
    client.attach(sourceOver("attachment-three", "capture.bin", ATTACHMENT_CHUNK_BYTE_CAP * 2));
    await new Promise((settle) => setTimeout(settle, 0));

    gate.open();
    await new Promise((settle) => setTimeout(settle, 0));

    expect(port.chunkCalls).toHaveLength(2);
    expect(client.snapshot[0]?.state).toBe("complete");
    expect(port.abortedIngestIds).toStrictEqual([]);
  });
});
