// The ingest client: the three calls, the ledger, the replay, and the abandonment.
//
// The client is driven directly — never a local re-implementation of it — against a
// bridge whose growth port is scripted. A scripted COLLABORATOR is what makes two of
// these cases checkable at all: that a retry re-sends the same sequence number
// carrying the same bytes, and that the bytes sent are the file — only the port on the
// other side of the seam can witness either.

import { MAX_MESSAGE_BYTES } from "@ai-sidekicks/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ConsoleBridge } from "../bridge/index.js";
import { ATTACHMENT_CHUNK_BYTE_CAP, consoleTripwires } from "../core/index.js";
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

/** Decode with the platform, so the transport check is against RFC 4648 and not against us. */
function decodeWithPlatform(encoded: string): Uint8Array<ArrayBuffer> {
  const latin1 = atob(encoded);
  const bytes = new Uint8Array(latin1.length);
  for (let index = 0; index < latin1.length; index += 1) {
    bytes[index] = latin1.charCodeAt(index);
  }
  return bytes;
}

/**
 * The first position at which two byte runs differ, or -1 when they are identical.
 *
 * A megabyte of bytes is compared here rather than through a deep-equality matcher:
 * the matcher's element-by-element machinery costs twenty seconds on a payload this
 * size, and the answer it gives back is less useful than the index.
 */
function firstDifferingIndex(actual: Uint8Array, expected: Uint8Array): number {
  if (actual.length !== expected.length) {
    return Math.min(actual.length, expected.length);
  }
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== expected[index]) {
      return index;
    }
  }
  return -1;
}

/** Whether one recorded request actually carried bytes, rather than describing them. */
function carriesAPayload(request: Readonly<Record<string, unknown>>): boolean {
  const chunk = request["chunk"];
  return typeof chunk === "string" && chunk.length > 0;
}

/** Everything the recorded chunks delivered, in the order they were sent. */
function deliveredBytes(chunkCalls: readonly RecordedChunk[]): Uint8Array<ArrayBuffer> {
  const decoded = chunkCalls.map((call) => decodeWithPlatform(call.chunk));
  const delivered = new Uint8Array(decoded.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of decoded) {
    delivered.set(part, offset);
    offset += part.length;
  }
  return delivered;
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

  public refuseChunksWith(code: string | undefined): void {
    this.#chunkRefusalCode = code;
  }

  public refuseCompletionWith(code: string | undefined): void {
    this.#completeRefusalCode = code;
  }

  public asBridge(): ConsoleBridge {
    const port = {
      artifactIngestBegin: async () => ({ status: "served", value: { ingestId: "ingest-1" } }),
      artifactIngestWriteChunk: async (request: RecordedChunk) => {
        this.chunkCalls.push(request);
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

const SMALL_SOURCE = attachmentSourceFrom({
  localId: "attachment-1",
  declaredName: "notes.md",
  payload: new Blob([patternedBytes(300)]),
  declaredMediaType: "text/plain",
});

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
    expect(deliveredBytes(port.chunkCalls)).toStrictEqual(patternedBytes(300));
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

  it("bounds a chunk at the fixed chunk cap rather than sending one frame", async () => {
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    client.attach(sourceOver("attachment-big", "dump.log", ATTACHMENT_CHUNK_BYTE_CAP + 10));
    await new Promise((settle) => setTimeout(settle, 0));

    expect(port.chunkCalls.map((call) => decodeWithPlatform(call.chunk).length)).toStrictEqual([
      ATTACHMENT_CHUNK_BYTE_CAP,
      10,
    ]);
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
  it("delivers a three-chunk payload byte for byte", async () => {
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    const byteLength = ATTACHMENT_CHUNK_BYTE_CAP * 2 + 7;
    client.attach(sourceOver("attachment-three", "capture.bin", byteLength));
    await new Promise((settle) => setTimeout(settle, 0));

    // Three requests, consecutively numbered from zero, whose decoded concatenation is
    // the file. Anything less and Complete would mint an artifact over bytes the daemon
    // never received.
    expect(port.chunkCalls.map((call) => call.sequenceNumber)).toStrictEqual([0, 1, 2]);
    expect(firstDifferingIndex(deliveredBytes(port.chunkCalls), patternedBytes(byteLength))).toBe(
      -1,
    );
    expect(client.snapshot[0]?.state).toBe("complete");
  });

  it("keeps every chunk inside the cap, encoded and decoded", async () => {
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    client.attach(sourceOver("attachment-three", "capture.bin", ATTACHMENT_CHUNK_BYTE_CAP * 2 + 7));
    await new Promise((settle) => setTimeout(settle, 0));

    for (const call of port.chunkCalls) {
      // The cap binds the DECODED bytes, and the frame ceiling binds what is actually
      // written — which is why the cap sits where it does rather than at the ceiling.
      expect(decodeWithPlatform(call.chunk).length).toBeLessThanOrEqual(ATTACHMENT_CHUNK_BYTE_CAP);
      expect(call.chunk.length).toBeLessThan(MAX_MESSAGE_BYTES);
    }
  });

  it("every request carries its bytes rather than a description of them", async () => {
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    client.attach(SMALL_SOURCE);
    await new Promise((settle) => setTimeout(settle, 0));

    expect(port.chunkCalls.length).toBeGreaterThan(0);
    expect(port.chunkCalls.every((call) => carriesAPayload(call))).toBe(true);
  });

  it("negative control: the byte comparison finds a difference when there is one", () => {
    // Without this, the delivery assertion above would pass over a comparison that
    // answered "identical" for any two runs at all.
    expect(firstDifferingIndex(patternedBytes(64), patternedBytes(65))).toBe(64);
    expect(firstDifferingIndex(new Uint8Array([1, 2, 3]), new Uint8Array([1, 9, 3]))).toBe(1);
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

describe("ingest client — abandonment and declared order", () => {
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

  it("round-trips a participant's reordering, which the reference must preserve", async () => {
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    client.attach(sourceOver("first", "a.md", 1));
    client.attach(sourceOver("second", "b.md", 1));
    await new Promise((settle) => setTimeout(settle, 0));

    client.reorder("second", 0);
    expect(client.snapshot.map((entry) => entry.declared.localId)).toStrictEqual([
      "second",
      "first",
    ]);
  });

  it("negative control: removing takes the position with it", async () => {
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    client.attach(sourceOver("first", "a.md", 1));
    client.attach(sourceOver("second", "b.md", 1));
    await new Promise((settle) => setTimeout(settle, 0));

    client.remove("first");
    expect(client.snapshot.map((entry) => entry.declared.localId)).toStrictEqual(["second"]);
  });
});
