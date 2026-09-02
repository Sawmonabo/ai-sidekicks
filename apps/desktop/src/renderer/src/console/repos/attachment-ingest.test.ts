// The ingest client: the three calls, the replay, and the abandonment.
//
// The client is driven directly — never a local re-implementation of it — against a
// bridge whose growth port is scripted, and the port both records and HOLDS: only a
// collaborator on the other side of the seam can witness that a retry re-sent one
// sequence number with identical bytes, and only one that can be held mid-call can put
// an abandonment inside an await.

import { MAX_MESSAGE_BYTES } from "@ai-sidekicks/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ConsoleBridge } from "../bridge/index.js";
import { ATTACHMENT_CHUNK_BYTE_CAP, consoleTripwires, encodeBase64 } from "../core/index.js";
import { AttachmentIngestClient } from "./attachment-ingest.js";
import {
  INGEST_CAPACITY_EXHAUSTED_CODE,
  INGEST_STREAM_INVALID_CODE,
  attachmentSourceFrom,
  type AttachmentSource,
} from "./attachment-model.js";

/**
 * One recorded chunk call: exactly the members `AttachmentIngestChunkRequest` names.
 *
 * The recorder types the REGISTERED shape rather than whatever the client happens to
 * send, so a request that went back to describing an offset would not compile here.
 */
type RecordedChunk = {
  readonly ingestId: string;
  readonly sequenceNumber: number;
  readonly chunk: string;
};

/** Bytes that differ at every position, so a concatenation check can actually fail. */
function patternedBytes(byteLength: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(byteLength);
  for (let index = 0; index < byteLength; index += 1) {
    bytes[index] = (index * 7 + 13) % 251;
  }
  return bytes;
}

/** A promise the case opens by hand, so a call can be caught mid-flight. */
function manualGate(): { readonly promise: Promise<void>; readonly open: () => void } {
  let release = (): void => {};
  const promise = new Promise<void>((settle) => {
    release = (): void => {
      settle();
    };
  });
  return {
    promise,
    open: (): void => {
      release();
    },
  };
}

/** Whether one recorded request actually carried bytes, rather than describing them. */
function carriesAPayload(request: Readonly<Record<string, unknown>>): boolean {
  const chunk = request["chunk"];
  return typeof chunk === "string" && chunk.length > 0;
}

/**
 * A growth port that answers what the case tells it to.
 *
 * A class with private fields, matching the tree's rule, and it records rather than
 * asserts: a recorder lets each case ask its own question of the same script.
 */
class ScriptedGrowthPort {
  readonly chunkCalls: RecordedChunk[] = [];
  readonly abortedIngestIds: string[] = [];
  #chunkRefusalCode: string | undefined;
  #completeRefusalCode: string | undefined;
  #beginGate: Promise<void> | undefined;
  #chunkGate: Promise<void> | undefined;

  public refuseChunksWith(code: string | undefined): void {
    this.#chunkRefusalCode = code;
  }

  public refuseCompletionWith(code: string | undefined): void {
    this.#completeRefusalCode = code;
  }

  /** Hold the next `begin` until the returned gate is opened; later calls run free. */
  public holdBegin(): { readonly open: () => void } {
    const gate = manualGate();
    this.#beginGate = gate.promise;
    return gate;
  }

  /** Hold the next chunk until the returned gate is opened; later calls run free. */
  public holdChunks(): { readonly open: () => void } {
    const gate = manualGate();
    this.#chunkGate = gate.promise;
    return gate;
  }

  public asBridge(): ConsoleBridge {
    const port = {
      artifactIngestBegin: async () => {
        await this.#beginGate;
        return { status: "served", value: { ingestId: "ingest-1" } };
      },
      artifactIngestWriteChunk: async (request: RecordedChunk) => {
        this.chunkCalls.push(request);
        await this.#chunkGate;
        return this.#chunkRefusalCode === undefined
          ? { status: "served", value: undefined }
          : { status: "unavailable", code: this.#chunkRefusalCode, detail: "scripted refusal" };
      },
      artifactIngestComplete: async () =>
        this.#completeRefusalCode === undefined
          ? {
              status: "served",
              value: {
                artifactId: "artifact-9",
                contentHash:
                  "sha256:9b1f1e9d0c3a4b5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6",
                normalizedName: "notes-1.md",
                derivedMediaType: "text/markdown",
                derivedSizeBytes: 300,
              },
            }
          : {
              status: "unavailable",
              code: this.#completeRefusalCode,
              detail: "scripted refusal",
            },
      artifactIngestAbort: async (request: { readonly ingestId: string }) => {
        this.abortedIngestIds.push(request.ingestId);
        return { status: "served", value: undefined };
      },
    };
    return { growth: port } as unknown as ConsoleBridge;
  }
}

function clientOver(port: ScriptedGrowthPort): AttachmentIngestClient {
  return new AttachmentIngestClient({ bridge: port.asBridge(), sessionId: "session-1" });
}

/** One source over bytes the test can recognise on the other side of the wire. */
function sourceOver(localId: string, declaredName: string, byteLength: number): AttachmentSource {
  return attachmentSourceFrom({
    localId,
    declaredName,
    payload: new Blob([patternedBytes(byteLength)]),
  });
}

const SMALL_SOURCE = sourceOver("attachment-1", "notes.md", 300);

beforeEach(() => {
  consoleTripwires.setThrowOnReport(false);
  consoleTripwires.reset();
});

afterEach(() => {
  consoleTripwires.reset();
  consoleTripwires.setThrowOnReport(import.meta.env.DEV);
});

describe("ingest client — the happy stream", () => {
  it("opens, sends the declared decoded bytes, and completes", async () => {
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    client.attach(SMALL_SOURCE);
    await Promise.resolve();
    await new Promise((settle) => setTimeout(settle, 0));

    expect(port.chunkCalls.map((call) => call.ingestId)).toStrictEqual(["ingest-1"]);
    expect(port.chunkCalls.map((call) => call.sequenceNumber)).toStrictEqual([0]);
    expect(port.chunkCalls[0]?.chunk).toBe(encodeBase64(patternedBytes(300)));
    const [entry] = client.snapshot;
    expect(entry?.state).toBe("complete");
    expect(entry?.receivedBytes).toBe(300);
  });

  it("replaces the declaration with the derived truth, and never the other way round", async () => {
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    client.attach(SMALL_SOURCE);
    await new Promise((settle) => setTimeout(settle, 0));

    const [entry] = client.snapshot;
    expect(entry?.derived).toStrictEqual({
      artifactId: "artifact-9",
      normalizedName: "notes-1.md",
      derivedMediaType: "text/markdown",
      derivedSizeBytes: 300,
    });
    // The declaration survives as what the caller said, never overwritten in place.
    expect(entry?.declared.declaredName).toBe("notes.md");
    expect(client.attachmentArtifactIds()).toStrictEqual(["artifact-9"]);
  });

  it("negative control: nothing is sent for an attachment nobody attached", async () => {
    // Without this, every assertion above would pass over a port that recorded calls
    // the client never made.
    const port = new ScriptedGrowthPort();
    clientOver(port);
    await new Promise((settle) => setTimeout(settle, 0));
    expect(port.chunkCalls).toStrictEqual([]);
  });
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

describe("ingest client — retry replays, and one refusal restarts", () => {
  it("re-sends the same chunk after a lost response", async () => {
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    port.refuseChunksWith("wire-unregistered");
    client.attach(SMALL_SOURCE);
    await new Promise((settle) => setTimeout(settle, 0));
    expect(client.snapshot[0]?.disposition).toBe("retry-in-place");

    port.refuseChunksWith(undefined);
    client.retry("attachment-1");
    await new Promise((settle) => setTimeout(settle, 0));

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
    await new Promise((settle) => setTimeout(settle, 0));

    expect(client.snapshot[0]?.disposition).toBe("restart");
    expect(client.snapshot[0]?.refusal?.code).toBe(INGEST_STREAM_INVALID_CODE);
  });

  it("negative control: the capacity refusal keeps its stream and waits", async () => {
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    port.refuseChunksWith(INGEST_CAPACITY_EXHAUSTED_CODE);
    client.attach(SMALL_SOURCE);
    await new Promise((settle) => setTimeout(settle, 0));

    expect(client.snapshot[0]?.disposition).toBe("wait-and-retry");
    expect(client.snapshot[0]?.ingestId).toBe("ingest-1");
  });

  it("replays a lost completion rather than re-uploading", async () => {
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    port.refuseCompletionWith("wire-unregistered");
    client.attach(SMALL_SOURCE);
    await new Promise((settle) => setTimeout(settle, 0));
    expect(client.snapshot[0]?.state).toBe("refused");

    port.refuseCompletionWith(undefined);
    client.retry("attachment-1");
    await new Promise((settle) => setTimeout(settle, 0));

    // One chunk sent in total: the retry resumed at the end of the ledger and went
    // straight back to completion.
    expect(port.chunkCalls).toHaveLength(1);
    expect(client.snapshot[0]?.state).toBe("complete");
  });
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
