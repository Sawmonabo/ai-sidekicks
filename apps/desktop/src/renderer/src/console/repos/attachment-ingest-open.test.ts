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
} from "./attachment-ingest-scripted-port.js";

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
