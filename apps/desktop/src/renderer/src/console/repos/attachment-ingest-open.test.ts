// Opening a stream: what `AttachmentIngestInit` carries, and what the run through to
// completion looks like when nothing refuses.
//
// The client is driven directly — never a local re-implementation of it — against the
// scripted growth port beside it, which records every request so a case can ask what was
// actually sent rather than what the client meant to send.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { consoleTripwires, encodeBase64 } from "../core/index.js";
import {
  SMALL_SOURCE,
  ScriptedGrowthPort,
  clientOver,
  patternedBytes,
  sourceOver,
} from "./attachment-ingest-scripted-port.js";
import { INGEST_STREAM_INVALID_CODE } from "./attachment-model.js";

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

describe("ingest client — what Init declares", () => {
  it("forwards the media type the participant's file carried", async () => {
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    client.attach(sourceOver("attachment-notes", "notes.md", 300, "text/markdown"));
    await new Promise((settle) => setTimeout(settle, 0));

    // A leading-byte signature determines nothing for a textual subtype, so this
    // declaration is the whole of what could admit the payload under the
    // signature-exempt branch. The other three members are asserted in the same breath
    // because they are the registered spellings — a request that went back to naming a
    // `name` and a `byteLength` would fail here rather than at the daemon.
    expect(port.initCalls).toStrictEqual([
      {
        sessionId: "session-1",
        fileName: "notes.md",
        mediaType: "text/markdown",
        declaredSizeBytes: 300,
      },
    ]);
  });

  it("sends no media type member at all when the source declared none", async () => {
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    client.attach(SMALL_SOURCE);
    await new Promise((settle) => setTimeout(settle, 0));

    // The KEY's absence, not an `undefined` value: absence is a first-class state the
    // contract names, and a member present-and-empty would be this console declaring a
    // type it was never told.
    const [initCall] = port.initCalls;
    expect(initCall).toBeDefined();
    expect(Object.hasOwn(initCall ?? {}, "mediaType")).toBe(false);
    expect(initCall?.fileName).toBe("notes.md");
  });

  it("negative control: an empty declaration is an absent one, not an empty string", async () => {
    // A `File` off a picker carries an empty `type` when the browser could not place it.
    // Without this, a fix that sent `mediaType: declared ?? ""` — or forwarded the empty
    // string verbatim — would pass the case above.
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    client.attach(sourceOver("attachment-unplaced", "capture.bin", 300, ""));
    await new Promise((settle) => setTimeout(settle, 0));

    const [initCall] = port.initCalls;
    expect(initCall).toBeDefined();
    expect(Object.hasOwn(initCall ?? {}, "mediaType")).toBe(false);
  });

  it("declares the same media type again when a terminal refusal restarts the stream", async () => {
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    port.refuseChunksWith(INGEST_STREAM_INVALID_CODE);
    client.attach(sourceOver("attachment-notes", "notes.md", 300, "text/markdown"));
    await new Promise((settle) => setTimeout(settle, 0));
    expect(client.snapshot[0]?.disposition).toBe("restart");

    port.refuseChunksWith(undefined);
    client.retry("attachment-notes");
    await new Promise((settle) => setTimeout(settle, 0));

    // A restart re-opens the stream, so the second Init has to carry the declaration too:
    // it is read from the ledger's own record of what the participant handed over, which
    // a dropped stream identity does not touch.
    expect(port.initCalls.map((call) => call.mediaType)).toStrictEqual([
      "text/markdown",
      "text/markdown",
    ]);
    expect(client.snapshot[0]?.state).toBe("complete");
  });
});
