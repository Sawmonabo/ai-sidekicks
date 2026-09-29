// Abandonment and disposal: sending stops at once, the spool is asked for back, and a
// call already in flight does not resume what a user stopped.
//
// The client is driven directly against the scripted ingest port beside it, which can be
// HELD mid-call — the only way to put an abandonment inside an await and see what the
// continuation does when it comes back to a ledger that moved underneath it.

import { ATTACHMENT_INGEST_CHUNK_MAX_BYTES } from "@ai-sidekicks/contracts";

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

    // Abandoned before the daemon answered: nothing in the ledger names a stream yet.
    client.abandon("attachment-1");
    expect(port.abortedIngestIds).toStrictEqual([]);
    gate.open();
    await crossMacrotaskBoundary();

    // The continuation neither resumed the abandoned entry nor sent a chunk, and it
    // asked for the spool of the stream the daemon opened underneath it — the one call
    // that could, since that id reached no entry for `abandon` to find.
    expect(client.snapshot[0]?.state).toBe("abandoned");
    expect(port.chunkCalls).toStrictEqual([]);
    expect(port.abortedIngestIds).toStrictEqual(["ingest-1"]);
  });

  it("sends no further chunk after an abandonment mid-chunk", async () => {
    const port = new ScriptedIngestPort();
    const client = clientOver(port);
    const gate = port.holdChunks();
    client.attach(
      sourceOver("attachment-three", "capture.bin", ATTACHMENT_INGEST_CHUNK_MAX_BYTES * 2),
    );
    await crossMacrotaskBoundary();
    expect(port.chunkCalls).toHaveLength(1);

    client.abandon("attachment-three");
    gate.open();
    await crossMacrotaskBoundary();

    // One chunk in flight, one abandonment, and no second chunk. The abort rode the
    // abandonment itself, because the stream identity was in the ledger by then.
    expect(port.chunkCalls).toHaveLength(1);
    expect(client.snapshot[0]?.state).toBe("abandoned");
    expect(port.abortedIngestIds).toStrictEqual(["ingest-1"]);
  });

  it("negative control: an unabandoned stream in flight runs to completion", async () => {
    // Without this, both cases above would pass over a client that stopped after one
    // chunk whatever the user did.
    const port = new ScriptedIngestPort();
    const client = clientOver(port);
    const gate = port.holdChunks();
    client.attach(
      sourceOver("attachment-three", "capture.bin", ATTACHMENT_INGEST_CHUNK_MAX_BYTES * 2),
    );
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
  async function carrierWithTwoOpenAndOneComplete(): Promise<{
    readonly port: ScriptedIngestPort;
    readonly client: ReturnType<typeof clientOver>;
  }> {
    const port = new ScriptedIngestPort();
    const client = clientOver(port);
    // The completed one first, so its stream identity is `ingest-1` and the two the
    // case is about are the ones a per-stream abort has to name.
    client.attach(SMALL_SOURCE);
    await crossMacrotaskBoundary();
    expect(client.snapshot[0]?.state).toBe("complete");

    port.holdChunks();
    client.attach(
      sourceOver("attachment-two", "capture.bin", ATTACHMENT_INGEST_CHUNK_MAX_BYTES * 2),
    );
    client.attach(
      sourceOver("attachment-three", "capture.bin", ATTACHMENT_INGEST_CHUNK_MAX_BYTES * 2),
    );
    await crossMacrotaskBoundary();
    return { port, client };
  }

  it("aborts every open stream and leaves the completed one alone", async () => {
    // The ingest ids live in the ledger and nowhere else, so a disposal that took the
    // ledger first left these spools and their aggregate reservations standing until
    // the daemon's reaper — long enough for a later upload to fail capacity admission.
    const { port, client } = await carrierWithTwoOpenAndOneComplete();

    client.dispose();

    expect(port.abortedIngestIds).toStrictEqual(["ingest-2", "ingest-3"]);
    // Terminal: a second disposal asks for nothing a second time, so a carrier torn
    // down twice does not send the daemon two reclaim requests for one spool.
    client.dispose();
    expect(port.abortedIngestIds).toStrictEqual(["ingest-2", "ingest-3"]);
  });

  it("negative control: a carrier holding only completed streams asks for nothing back", async () => {
    // Without this the case above would pass against a disposal that aborted every
    // entry it held, which would ask the daemon to reclaim a finished ingest.
    const port = new ScriptedIngestPort();
    const client = clientOver(port);
    client.attach(SMALL_SOURCE);
    await crossMacrotaskBoundary();

    client.dispose();

    expect(port.abortedIngestIds).toStrictEqual([]);
  });

  it("negative control: an already-abandoned stream is not asked for back twice", async () => {
    // `abandon` asked for this spool the moment sending stopped. A second request for
    // one spool is a duplicate rather than a safeguard.
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
