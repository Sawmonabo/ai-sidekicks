// The ingest client: the three calls, the ledger, the replay, and the abandonment.
//
// The client is driven directly — never a local re-implementation of it — against a
// bridge whose growth port is scripted. A scripted COLLABORATOR is what makes the
// replay case checkable at all: the point of retry-in-place is that a second attempt
// re-sends the chunk at the SAME offset, and only the port can witness that.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ConsoleBridge } from "../bridge/index.js";
import { ATTACHMENT_CHUNK_BYTE_CAP, consoleTripwires } from "../core/index.js";
import { AttachmentIngestClient } from "./attachment-ingest.js";
import { INGEST_CAPACITY_EXHAUSTED_CODE, INGEST_STREAM_INVALID_CODE } from "./attachment-model.js";

/** One recorded chunk call, so the replay assertion reads offsets rather than counts. */
interface RecordedChunk {
  readonly ingestId: string;
  readonly offset: number;
  readonly byteLength: number;
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

const SMALL_SOURCE = {
  localId: "attachment-1",
  declaredName: "notes.md",
  byteLength: 300,
  declaredMediaType: "text/plain",
} as const;

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

    expect(port.chunkCalls).toStrictEqual([{ ingestId: "ingest-1", offset: 0, byteLength: 300 }]);
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
    client.attach({
      localId: "attachment-big",
      declaredName: "dump.log",
      byteLength: ATTACHMENT_CHUNK_BYTE_CAP + 10,
    });
    await new Promise((settle) => setTimeout(settle, 0));

    expect(port.chunkCalls.map((call) => call.byteLength)).toStrictEqual([
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

describe("ingest client — retry replays, and one refusal restarts", () => {
  it("re-sends the same offset after a lost response", async () => {
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    port.refuseChunksWith("wire-unregistered");
    client.attach(SMALL_SOURCE);
    await new Promise((settle) => setTimeout(settle, 0));
    expect(client.snapshot[0]?.disposition).toBe("retry-in-place");

    port.refuseChunksWith(undefined);
    client.retry("attachment-1");
    await new Promise((settle) => setTimeout(settle, 0));

    // Two chunk calls at the SAME offset: the replay, not a restart. The daemon
    // acknowledges a replayed chunk without re-appending it, which is what makes this
    // the cheap answer to a lost response.
    expect(port.chunkCalls.map((call) => call.offset)).toStrictEqual([0, 0]);
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
    client.attach({ localId: "first", declaredName: "a.md", byteLength: 1 });
    client.attach({ localId: "second", declaredName: "b.md", byteLength: 1 });
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
    client.attach({ localId: "first", declaredName: "a.md", byteLength: 1 });
    client.attach({ localId: "second", declaredName: "b.md", byteLength: 1 });
    await new Promise((settle) => setTimeout(settle, 0));

    client.remove("first");
    expect(client.snapshot.map((entry) => entry.declared.localId)).toStrictEqual(["second"]);
  });
});
