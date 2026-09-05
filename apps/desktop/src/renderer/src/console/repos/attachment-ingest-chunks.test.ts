// The chunk loop: which bytes go, in which order, and that they GO rather than being
// described.
//
// The client is driven directly against the scripted growth port beside it, which records
// every chunk request — the only vantage point from which "the daemon received the file"
// is a checkable claim rather than an intention.

import { MAX_MESSAGE_BYTES } from "@ai-sidekicks/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ATTACHMENT_CHUNK_BYTE_CAP, encodeBase64 } from "../core/index.js";
import { consoleTripwires } from "../core/tripwires.js";
import { CHUNK_ACKNOWLEDGEMENT_UNUSABLE_CODE } from "./attachment-ingest-acknowledgement.js";
import {
  ScriptedGrowthPort,
  clientOver,
  patternedBytes,
  sourceOver,
} from "./attachment-ingest-scripted-port.js";
import { INGEST_CAPACITY_EXHAUSTED_CODE } from "./attachment-policy.js";

/** Whether one recorded request actually carried bytes, rather than describing them. */
function carriesAPayload(request: Readonly<Record<string, unknown>>): boolean {
  const chunk = request["chunk"];
  return typeof chunk === "string" && chunk.length > 0;
}

beforeEach(() => {
  consoleTripwires.setThrowOnReport(false);
  consoleTripwires.reset();
});

afterEach(() => {
  consoleTripwires.reset();
  consoleTripwires.setThrowOnReport(import.meta.env.DEV);
});

describe("ingest client — the payload reaches the daemon", () => {
  it("sends the file as cap-sized slices, in order, inside the frame ceiling", async () => {
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    const byteLength = ATTACHMENT_CHUNK_BYTE_CAP * 2 + 7;
    const payload = patternedBytes(byteLength);
    client.attach(sourceOver("attachment-three", "capture.bin", byteLength));
    await new Promise((settle) => setTimeout(settle, 0));

    // Three requests, consecutively numbered from zero, each carrying exactly the slice
    // at its own offset — the chunks tile the file with nothing dropped, repeated, or
    // reordered. The expectation is built with the encoder rather than read back through
    // a decoder, because what is under test is WHICH bytes went; that the encoding is
    // RFC 4648 is `core/base64.test.ts`'s claim, made there against the platform's own.
    expect(port.chunkCalls.map((call) => call.sequenceNumber)).toStrictEqual([0, 1, 2]);
    expect(port.chunkCalls.every((call) => carriesAPayload(call))).toBe(true);
    expect(port.chunkCalls.map((call) => call.chunk)).toStrictEqual([
      encodeBase64(payload.subarray(0, ATTACHMENT_CHUNK_BYTE_CAP)),
      encodeBase64(payload.subarray(ATTACHMENT_CHUNK_BYTE_CAP, ATTACHMENT_CHUNK_BYTE_CAP * 2)),
      encodeBase64(payload.subarray(ATTACHMENT_CHUNK_BYTE_CAP * 2)),
    ]);
    for (const call of port.chunkCalls) {
      // The cap binds the decoded bytes and the ceiling binds what is written, which is
      // why the cap sits where it does rather than at the ceiling.
      expect(call.chunk.length).toBeLessThan(MAX_MESSAGE_BYTES);
    }
    expect(client.snapshot[0]?.state).toBe("complete");
  });

  it("negative control: an offset and a claimed length carry no payload", () => {
    // The shape this client sent before — the daemon could not have received one byte
    // of the file from it. Without this control, the assertion above would pass over a
    // predicate that answered true for anything at all.
    expect(carriesAPayload({ ingestId: "ingest-1", offset: 0, byteLength: 300 })).toBe(false);
    expect(carriesAPayload({ ingestId: "ingest-1", sequenceNumber: 0, chunk: "" })).toBe(false);
  });

  it("stops the stream at the refusal rather than sending the rest", async () => {
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    port.refuseChunksWith(INGEST_CAPACITY_EXHAUSTED_CODE);
    client.attach(sourceOver("attachment-three", "capture.bin", ATTACHMENT_CHUNK_BYTE_CAP * 2 + 7));
    await new Promise((settle) => setTimeout(settle, 0));

    expect(port.chunkCalls).toHaveLength(1);
    expect(client.snapshot[0]?.state).toBe("refused");
    expect(client.snapshot[0]?.refusal?.code).toBe(INGEST_CAPACITY_EXHAUSTED_CODE);
  });
});

describe("ingest client — the ledger advances on what the daemon acknowledged", () => {
  it("charts the reply's running total rather than the bytes it sent", async () => {
    // The bug, exercised through the real loop: the ledger used to add the local slice
    // length and never read the reply, so the progress figure recorded what went on the
    // wire rather than what the daemon spooled — and the client could not have told the
    // two apart, because it was never looking at the acknowledgement.
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    const byteLength = ATTACHMENT_CHUNK_BYTE_CAP + 7;
    client.attach(sourceOver("attachment-four", "capture.bin", byteLength));
    await new Promise((settle) => setTimeout(settle, 0));

    expect(port.chunkCalls.map((call) => call.sequenceNumber)).toStrictEqual([0, 1]);
    expect(client.snapshot[0]?.receivedBytes).toBe(byteLength);
    expect(client.snapshot[0]?.state).toBe("complete");
  });

  it("refuses an acknowledgement that names another stream", async () => {
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    port.acknowledgeChunksWith({ ingestId: "ingest-7", receivedBytes: 300 });
    client.attach(sourceOver("attachment-four", "notes.md", 300));
    await new Promise((settle) => setTimeout(settle, 0));

    expect(port.chunkCalls).toHaveLength(1);
    expect(client.snapshot[0]?.state).toBe("refused");
    expect(client.snapshot[0]?.refusal?.code).toBe(CHUNK_ACKNOWLEDGEMENT_UNUSABLE_CODE);
    // `restart` and not the retry-in-place default: that default assumes the two sides
    // still share an offset, which is what this reply has broken.
    expect(client.snapshot[0]?.disposition).toBe("restart");
  });

  it("refuses a total that did not advance rather than re-slicing forever", async () => {
    // The offset IS the ledger, so a client that accepted a standing total would send
    // the same chunk for as long as the daemon kept answering. The refusal is what makes
    // the loop terminate on the daemon's own answer, and the call count is the proof.
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    port.acknowledgeChunksWith({ ingestId: "ingest-1", receivedBytes: 0 });
    client.attach(sourceOver("attachment-four", "capture.bin", ATTACHMENT_CHUNK_BYTE_CAP * 2));
    await new Promise((settle) => setTimeout(settle, 0));

    expect(port.chunkCalls).toHaveLength(1);
    expect(client.snapshot[0]?.state).toBe("refused");
    expect(client.snapshot[0]?.receivedBytes).toBe(0);
  });

  it("negative control: the daemon's own partial total is taken verbatim and the stream goes on", async () => {
    // Without this, a check that refused whenever the reply disagreed with the local
    // count would pass both cases above while making every lawful partial spool a
    // refusal — which is precisely the daemon's answer this change exists to trust.
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    client.attach(sourceOver("attachment-four", "notes.md", 300));
    await new Promise((settle) => setTimeout(settle, 0));

    expect(client.snapshot[0]?.state).toBe("complete");
    expect(client.snapshot[0]?.refusal).toBeUndefined();
    expect(consoleTripwires.totalFiringCount).toBe(0);
  });
});
