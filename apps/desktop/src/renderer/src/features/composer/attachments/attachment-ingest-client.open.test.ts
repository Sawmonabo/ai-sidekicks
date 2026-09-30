// Opening a stream: what `AttachmentIngestInit` carries, and the run through to completion when
// nothing refuses. The scripted port records every request so a case asks what was sent.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { encodeBase64 } from "./base64.js";
import { windowTripwires } from "@renderer/lib/tripwires.js";
import {
  INGEST_SESSION_ID,
  SMALL_SOURCE,
  ScriptedIngestPort,
  clientOver,
  patternedBytes,
  sourceOver,
} from "@test/helpers/scripted-ingest-port.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";

beforeEach(() => {
  windowTripwires.setThrowOnReport(false);
  windowTripwires.reset();
});

afterEach(() => {
  windowTripwires.reset();
  windowTripwires.setThrowOnReport(import.meta.env.DEV);
});

describe("ingest client — the happy stream", () => {
  it("opens, sends the declared decoded bytes, and completes", async () => {
    const port = new ScriptedIngestPort();
    const client = clientOver(port);
    client.attach(SMALL_SOURCE);
    await Promise.resolve();
    await crossMacrotaskBoundary();

    expect(port.chunkCalls.map((call) => call.ingestId)).toStrictEqual(["ingest-1"]);
    expect(port.chunkCalls.map((call) => call.sequenceNumber)).toStrictEqual([0]);
    expect(port.chunkCalls[0]?.chunk).toBe(encodeBase64(patternedBytes(300)));
    const [entry] = client.snapshot;
    expect(entry?.state).toBe("complete");
    expect(entry?.receivedBytes).toBe(300);
  });

  it("replaces the declaration with the derived truth, and never the other way round", async () => {
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
    expect(client.attachmentArtifactIds()).toStrictEqual(["artifact-9"]);
  });

  it("negative control: nothing is sent for an attachment nobody attached", async () => {
    // Without this every assertion above would pass over a port that recorded calls never made.
    const port = new ScriptedIngestPort();
    clientOver(port);
    await crossMacrotaskBoundary();
    expect(port.chunkCalls).toStrictEqual([]);
  });
});

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

  it("sends no media type member at all when the source declared none", async () => {
    const port = new ScriptedIngestPort();
    const client = clientOver(port);
    client.attach(SMALL_SOURCE);
    await crossMacrotaskBoundary();

    // The key's absence, not an `undefined` value: a present-and-empty member would declare a
    // type the console was never told.
    const [initCall] = port.initCalls;
    expect(initCall).toBeDefined();
    expect(Object.hasOwn(initCall ?? {}, "mediaType")).toBe(false);
    expect(initCall?.fileName).toBe("notes.md");
  });

  it("negative control: an empty declaration is an absent one, not an empty string", async () => {
    // A picker `File` has an empty `type` when the browser cannot place it. Without this a fix
    // sending `mediaType: declared ?? ""` would pass the case above.
    const port = new ScriptedIngestPort();
    const client = clientOver(port);
    client.attach(sourceOver("attachment-unplaced", "capture.bin", 300, ""));
    await crossMacrotaskBoundary();

    const [initCall] = port.initCalls;
    expect(initCall).toBeDefined();
    expect(Object.hasOwn(initCall ?? {}, "mediaType")).toBe(false);
  });

  it("declares the same media type again when the stream restarts", async () => {
    const port = new ScriptedIngestPort();
    const client = clientOver(port);
    port.acknowledgeChunksWith({ ingestId: "ingest-1", receivedBytes: 0 });
    client.attach(sourceOver("attachment-notes", "notes.md", 300, "text/markdown"));
    await crossMacrotaskBoundary();
    expect(client.snapshot[0]?.disposition).toBe("restart");

    port.acknowledgeChunksWith(undefined);
    client.retry("attachment-notes");
    await crossMacrotaskBoundary();

    // A restart re-opens the stream, so the second Init carries the declaration too, read from
    // the ledger's record of what the user handed over.
    expect(port.initCalls.map((call) => call.mediaType)).toStrictEqual([
      "text/markdown",
      "text/markdown",
    ]);
    expect(client.snapshot[0]?.state).toBe("complete");
  });
});
