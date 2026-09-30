// Abandonment and disposal: sending stops at once, the spool is asked for back, and a call in
// flight does not resume what a user stopped. The scripted port can be held mid-call, the only
// way to put an abandonment inside an await.

import { ARTIFACT_CHUNK_MAX_BYTES } from "@ai-sidekicks/contracts";

import { describe, expect, it } from "vitest";

import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import {
  SMALL_SOURCE,
  ScriptedIngestPort,
  clientOver,
  sourceOver,
} from "@test/helpers/scripted-ingest-port.js";

describe("ingest client — abandonment, including mid-call", () => {
  it("stops sending and asks for the spool back", async () => {
    const port = new ScriptedIngestPort();
    const client = clientOver(port);
    port.holdChunks();
    client.attach(SMALL_SOURCE);
    await crossMacrotaskBoundary();

    client.abandon("attachment-1");
    await crossMacrotaskBoundary();
    expect(client.snapshot[0]?.state).toBe("abandoned");
    expect(port.abortedIngestIds).toStrictEqual(["ingest-1"]);
  });

  it("negative control: a completed attachment is not abandonable", async () => {
    const port = new ScriptedIngestPort();
    const client = clientOver(port);
    client.attach(SMALL_SOURCE);
    await crossMacrotaskBoundary();

    client.abandon("attachment-1");
    expect(client.snapshot[0]?.state).toBe("complete");
    expect(port.abortedIngestIds).toStrictEqual([]);
  });

  it("stops a stream abandoned while its first call was in flight", async () => {
    const port = new ScriptedIngestPort();
    const client = clientOver(port);
    const gate = port.holdBegin();
    client.attach(SMALL_SOURCE);
    await crossMacrotaskBoundary();

    // Abandoned before the daemon answered: no stream is named in the ledger yet.
    client.abandon("attachment-1");
    expect(port.abortedIngestIds).toStrictEqual([]);
    gate.open();
    await crossMacrotaskBoundary();

    // The continuation asked for the spool of the stream the daemon opened underneath it, since
    // that id reached no entry for `abandon` to find.
    expect(client.snapshot[0]?.state).toBe("abandoned");
    expect(port.chunkCalls).toStrictEqual([]);
    expect(port.abortedIngestIds).toStrictEqual(["ingest-1"]);
  });

  it("sends no further chunk after an abandonment mid-chunk", async () => {
    const port = new ScriptedIngestPort();
    const client = clientOver(port);
    const gate = port.holdChunks();
    client.attach(sourceOver("attachment-three", "capture.bin", ARTIFACT_CHUNK_MAX_BYTES * 2));
    await crossMacrotaskBoundary();
    expect(port.chunkCalls).toHaveLength(1);

    client.abandon("attachment-three");
    gate.open();
    await crossMacrotaskBoundary();

    // One chunk in flight, one abandonment, no second chunk. The abort rode the abandonment,
    // because the stream identity was already in the ledger.
    expect(port.chunkCalls).toHaveLength(1);
    expect(client.snapshot[0]?.state).toBe("abandoned");
    expect(port.abortedIngestIds).toStrictEqual(["ingest-1"]);
  });

  it("negative control: an unabandoned stream in flight runs to completion", async () => {
    // Without this both cases above would pass over a client that stopped after one chunk.
    const port = new ScriptedIngestPort();
    const client = clientOver(port);
    const gate = port.holdChunks();
    client.attach(sourceOver("attachment-three", "capture.bin", ARTIFACT_CHUNK_MAX_BYTES * 2));
    await crossMacrotaskBoundary();

    gate.open();
    await crossMacrotaskBoundary();

    expect(port.chunkCalls).toHaveLength(2);
    expect(client.snapshot[0]?.state).toBe("complete");
    expect(port.abortedIngestIds).toStrictEqual([]);
  });
});

describe("ingest client — disposal gives every open spool back", () => {
  /** Two streams held open on their chunk call, and one that ran to completion. */
  async function stagedWithTwoOpenAndOneComplete(): Promise<{
    readonly port: ScriptedIngestPort;
    readonly client: ReturnType<typeof clientOver>;
  }> {
    const port = new ScriptedIngestPort();
    const client = clientOver(port);
    // The completed one first, so its stream identity is `ingest-1`.
    client.attach(SMALL_SOURCE);
    await crossMacrotaskBoundary();
    expect(client.snapshot[0]?.state).toBe("complete");

    port.holdChunks();
    client.attach(sourceOver("attachment-two", "capture.bin", ARTIFACT_CHUNK_MAX_BYTES * 2));
    client.attach(sourceOver("attachment-three", "capture.bin", ARTIFACT_CHUNK_MAX_BYTES * 2));
    await crossMacrotaskBoundary();
    return { port, client };
  }

  it("aborts every open stream and leaves the completed one alone", async () => {
    // Ingest ids live only in the ledger, so disposing it first left these spools and their
    // capacity reservations standing until the reaper ran.
    const { port, client } = await stagedWithTwoOpenAndOneComplete();

    client.dispose();

    expect(port.abortedIngestIds).toStrictEqual(["ingest-2", "ingest-3"]);
    // Terminal: a second disposal does not send a second reclaim request for one spool.
    client.dispose();
    expect(port.abortedIngestIds).toStrictEqual(["ingest-2", "ingest-3"]);
  });

  it("negative control: a staged list holding only completed streams asks for nothing back", async () => {
    // Without this the case above would pass against a disposal that aborted every entry.
    const port = new ScriptedIngestPort();
    const client = clientOver(port);
    client.attach(SMALL_SOURCE);
    await crossMacrotaskBoundary();

    client.dispose();

    expect(port.abortedIngestIds).toStrictEqual([]);
  });

  it("negative control: an already-abandoned stream is not asked for back twice", async () => {
    // `abandon` already asked for this spool; a second request would be a duplicate.
    const port = new ScriptedIngestPort();
    const client = clientOver(port);
    port.holdChunks();
    client.attach(SMALL_SOURCE);
    await crossMacrotaskBoundary();
    client.abandon("attachment-1");
    await crossMacrotaskBoundary();
    expect(port.abortedIngestIds).toStrictEqual(["ingest-1"]);

    client.dispose();

    expect(port.abortedIngestIds).toStrictEqual(["ingest-1"]);
  });
});
