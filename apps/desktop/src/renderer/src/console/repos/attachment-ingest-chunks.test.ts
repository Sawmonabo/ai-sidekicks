// The chunk loop: which bytes go, in which order, and that they GO rather than being
// described.
//
// The client is driven directly against the scripted growth port beside it, which records
// every chunk request — the only vantage point from which "the daemon received the file"
// is a checkable claim rather than an intention.

import { MAX_MESSAGE_BYTES } from "@ai-sidekicks/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ATTACHMENT_CHUNK_BYTE_CAP, consoleTripwires, encodeBase64 } from "../core/index.js";
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
