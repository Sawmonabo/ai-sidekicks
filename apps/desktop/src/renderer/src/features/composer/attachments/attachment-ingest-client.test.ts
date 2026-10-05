// The ingest client end to end over a scripted port that records every request: what Init
// declares, which bytes go and in which order, what an acknowledgement may move, how retry
// resumes or restarts, that an abandonment stops the bytes, and when the user's payload is let go.

import { ARTIFACT_CHUNK_MAX_BYTES } from "@ai-sidekicks/contracts/artifacts/ingest";
import { MAX_MESSAGE_BYTES } from "@ai-sidekicks/contracts/jsonrpc/jsonrpc";
import { describe, expect, it } from "vitest";

import { encodeBase64 } from "./base64.js";
import { readWireString } from "#renderer/lib/wire/strings.js";
import { CHUNK_ACKNOWLEDGEMENT_UNUSABLE_CODE } from "./services/attachment-ingest-acknowledgement.js";
import { PAYLOAD_READ_REFUSAL_CODE } from "./services/attachment-ingest-chunks.js";
import type { AttachmentIngestEntry } from "./shapes.js";
import {
  INGEST_SESSION_ID,
  SMALL_SOURCE,
  ScriptedIngestPort,
  clientOver,
  movableSourceOver,
  patternedBytes,
  sourceOver,
} from "#test/helpers/scripted-ingest-port.js";
import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";

/** Whether one recorded request carried bytes rather than describing them. */
function carriesAPayload(request: Readonly<Record<string, unknown>>): boolean {
  return readWireString(request["chunk"]) !== undefined;
}

/**
 * Whether this entry carries a payload, read as a property of the object: `payload === undefined`
 * would also pass over a member holding `undefined`, a different shape.
 */
function holdsPayload(entry: AttachmentIngestEntry | undefined): boolean {
  return entry !== undefined && Object.hasOwn(entry, "payload");
}

describe("ingest client — what Init declares", () => {
  it("forwards the media type the user's file carried", async () => {
    const port = new ScriptedIngestPort();
    const client = clientOver(port);
    client.attach(sourceOver("attachment-notes", "notes.md", 300, "text/markdown"));
    await crossMacrotaskBoundary();

    // A leading-byte signature decides nothing for a textual subtype, so this declaration alone
    // admits the payload under the signature-exempt branch. The other members are the registered
    // spellings: a request naming `name` and `byteLength` would fail here, not at the daemon.
    expect(port.initCalls).toStrictEqual([
      {
        sessionId: INGEST_SESSION_ID,
        fileName: "notes.md",
        mediaType: "text/markdown",
        declaredSizeBytes: 300,
      },
    ]);
  });

  it("sends no media type member when the file's type is empty", async () => {
    // A picker `File` has an empty `type` when the browser cannot place it; the key must be
    // absent, since a present-and-empty member would declare a type the console was never told.
    const port = new ScriptedIngestPort();
    const client = clientOver(port);
    client.attach(sourceOver("attachment-unplaced", "capture.bin", 300, ""));
    await crossMacrotaskBoundary();

    const [initCall] = port.initCalls;
    expect(initCall).toBeDefined();
    expect(Object.hasOwn(initCall ?? {}, "mediaType")).toBe(false);
  });
});

describe("ingest client — the payload reaches the daemon", () => {
  it("sends the file as cap-sized slices, in order, inside the frame ceiling", async () => {
    const port = new ScriptedIngestPort();
    const client = clientOver(port);
    const byteLength = ARTIFACT_CHUNK_MAX_BYTES * 2 + 7;
    const payload = patternedBytes(byteLength);
    client.attach(sourceOver("attachment-three", "capture.bin", byteLength));
    await crossMacrotaskBoundary();

    // Three consecutively numbered requests, each carrying the slice at its own offset. The
    // expectation is built with the encoder because what is under test is which bytes went;
    // the encoding itself is checked in `base64.test.ts`.
    expect(port.chunkCalls.map((call) => call.sequenceNumber)).toStrictEqual([0, 1, 2]);
    expect(port.chunkCalls.every((call) => carriesAPayload({ ...call }))).toBe(true);
    expect(port.chunkCalls.map((call) => call.chunk)).toStrictEqual([
      encodeBase64(payload.subarray(0, ARTIFACT_CHUNK_MAX_BYTES)),
      encodeBase64(payload.subarray(ARTIFACT_CHUNK_MAX_BYTES, ARTIFACT_CHUNK_MAX_BYTES * 2)),
      encodeBase64(payload.subarray(ARTIFACT_CHUNK_MAX_BYTES * 2)),
    ]);
    for (const call of port.chunkCalls) {
      // The cap binds the decoded bytes and the ceiling binds what is written.
      expect(call.chunk.length).toBeLessThan(MAX_MESSAGE_BYTES);
    }
    expect(client.snapshot[0]?.state).toBe("complete");
  });

  it("replaces the declaration with the derived values, never the reverse", async () => {
    const port = new ScriptedIngestPort();
    const client = clientOver(port);
    client.attach(SMALL_SOURCE);
    await crossMacrotaskBoundary();

    const [entry] = client.snapshot;
    expect(entry?.derived).toStrictEqual({
      artifactId: "artifact-9",
      fileName: "notes-1.md",
      mimeType: "text/markdown",
      sizeBytes: 300,
    });
    // The declaration survives as the caller gave it, never overwritten in place.
    expect(entry?.declared.declaredName).toBe("notes.md");
  });
});

describe("ingest client — the record advances on what the daemon acknowledged", () => {
  it("refuses an acknowledgement that names another stream", async () => {
    const port = new ScriptedIngestPort();
    const client = clientOver(port);
    port.acknowledgeChunksWith({ ingestId: "ingest-7", receivedBytes: 300 });
    client.attach(sourceOver("attachment-four", "notes.md", 300));
    await crossMacrotaskBoundary();

    expect(port.chunkCalls).toHaveLength(1);
    expect(client.snapshot[0]?.state).toBe("refused");
    expect(client.snapshot[0]?.refusal?.code).toBe(CHUNK_ACKNOWLEDGEMENT_UNUSABLE_CODE);
    // `restart`, not retry-in-place: that default assumes the two sides still share an offset.
    expect(client.snapshot[0]?.disposition).toBe("restart");
  });

  it("refuses a total that did not advance rather than re-slicing forever", async () => {
    // The offset is the record's, so a client accepting a standing total would resend the same
    // chunk forever; the refusal ends the loop and the call count proves it.
    const port = new ScriptedIngestPort();
    const client = clientOver(port);
    port.acknowledgeChunksWith({ ingestId: "ingest-1", receivedBytes: 0 });
    client.attach(sourceOver("attachment-four", "capture.bin", ARTIFACT_CHUNK_MAX_BYTES * 2));
    await crossMacrotaskBoundary();

    expect(port.chunkCalls).toHaveLength(1);
    expect(client.snapshot[0]?.state).toBe("refused");
    expect(client.snapshot[0]?.receivedBytes).toBe(0);
  });
});

describe("ingest client — a file that stops being readable", () => {
  it("refuses the entry, sends nothing for the unreadable slice, and offers a retry", async () => {
    const port = new ScriptedIngestPort();
    const client = clientOver(port);
    const movable = movableSourceOver(
      "attachment-moved",
      "capture.bin",
      ARTIFACT_CHUNK_MAX_BYTES * 2,
    );
    movable.moveFile();
    client.attach(movable.source);
    await crossMacrotaskBoundary();

    const [entry] = client.snapshot;
    expect(entry?.state).toBe("refused");
    expect(entry?.refusal?.code).toBe(PAYLOAD_READ_REFUSAL_CODE);
    expect(entry?.disposition).toBe("retry-in-place");
    // The read failed before a request was composed, so nothing was sent.
    expect(port.chunkCalls).toStrictEqual([]);
  });
});

describe("ingest client — retry resumes or begins again", () => {
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

describe("ingest client — abandonment, including mid-call", () => {
  it("stops a stream abandoned while its first call was in flight", async () => {
    const port = new ScriptedIngestPort();
    const client = clientOver(port);
    const gate = port.holdBegin();
    client.attach(SMALL_SOURCE);
    await crossMacrotaskBoundary();

    // Abandoned before the daemon answered: no stream is named in the record yet.
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
    // because the stream identity was already in the record.
    expect(port.chunkCalls).toHaveLength(1);
    expect(client.snapshot[0]?.state).toBe("abandoned");
    expect(port.abortedIngestIds).toStrictEqual(["ingest-1"]);
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
    // Ingest ids live only in the record, so disposing it first left these spools and their
    // capacity reservations standing until the reaper ran.
    const { port, client } = await stagedWithTwoOpenAndOneComplete();

    client.dispose();

    expect(port.abortedIngestIds).toStrictEqual(["ingest-2", "ingest-3"]);
    // Terminal: a second disposal does not send a second reclaim request for one spool.
    client.dispose();
    expect(port.abortedIngestIds).toStrictEqual(["ingest-2", "ingest-3"]);
  });
});

describe("attachment payload release — a finished upload lets the bytes go", () => {
  it("releases the payload when the ingest completes", async () => {
    const port = new ScriptedIngestPort();
    const client = clientOver(port);
    client.attach(SMALL_SOURCE);
    await crossMacrotaskBoundary();

    const [entry] = client.snapshot;
    expect(entry?.state).toBe("complete");
    // The artifact is minted, so nothing is left to send. The member is absent, not emptied.
    expect(holdsPayload(entry)).toBe(false);
    expect(entry?.payload).toBeUndefined();
    // Everything a card reads survives: the name, the declared size and the derived values.
    expect(entry?.declared.declaredName).toBe("notes.md");
    expect(entry?.declared.byteLength).toBe(300);
    expect(entry?.derived?.artifactId).toBe("artifact-9");
    expect(entry?.derived?.fileName).toBe("notes-1.md");
  });

  it("keeps the payload on a refused entry, so the retry has bytes to send", async () => {
    // The half a release rule gets wrong first: every disposition offers a retry, which
    // resends bytes an entry that let go could not produce.
    const port = new ScriptedIngestPort();
    const client = clientOver(port);
    port.acknowledgeChunksWith({ ingestId: "ingest-1", receivedBytes: 0 });
    client.attach(sourceOver("attachment-two", "capture.bin", ARTIFACT_CHUNK_MAX_BYTES * 2));
    await crossMacrotaskBoundary();

    const [refused] = client.snapshot;
    expect(refused?.state).toBe("refused");
    expect(holdsPayload(refused)).toBe(true);

    // The retry actually sends: the chunks on the wire after it are the proof.
    port.acknowledgeChunksWith(undefined);
    client.retry("attachment-two");
    await crossMacrotaskBoundary();

    expect(client.snapshot[0]?.state).toBe("complete");
    expect(port.chunkCalls).toHaveLength(3);
  });
});
