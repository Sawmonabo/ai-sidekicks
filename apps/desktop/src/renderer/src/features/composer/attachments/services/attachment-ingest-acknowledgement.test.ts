// What one chunk acknowledgement establishes, driven directly rather than through the protocol:
// the next offset is the daemon's spooled total, never the count this client sent.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { windowTripwires } from "@renderer/lib/tripwires.js";
import { readChunkAcknowledgement } from "./attachment-ingest-acknowledgement.js";
import { attachmentSourceFrom, type AttachmentIngestEntry } from "../attachment-shapes.js";

/** The stream every case here acknowledges against. */
const INGEST_ID = "ingest-1";

/** One in-flight entry declaring a decoded total, standing at a given offset. */
function entryDeclaring(byteLength: number, receivedBytes = 0): AttachmentIngestEntry {
  return {
    // Spread, because a source is the declaration and the bytes it describes.
    ...attachmentSourceFrom({
      localId: "attachment-1",
      declaredName: "notes.md",
      payload: new Blob([new Uint8Array(byteLength)]),
    }),
    state: "ingesting",
    receivedBytes,
    ingestId: INGEST_ID,
    derived: undefined,
    refusal: undefined,
    disposition: undefined,
    openedAtMilliseconds: 1_000,
    lastProgressAtMilliseconds: 1_000,
  };
}

beforeEach(() => {
  // The registry throws in a development build; these cases assert the record, so they read
  // it in the recording arm.
  windowTripwires.setThrowOnReport(false);
  windowTripwires.reset();
});

afterEach(() => {
  windowTripwires.reset();
  windowTripwires.setThrowOnReport(import.meta.env.DEV);
});

describe("chunk acknowledgement — the offset is the daemon's", () => {
  it("takes the daemon's running total rather than what this client sent", () => {
    // A daemon that had spooled a different amount must not be contradicted by the local slice
    // length; a partial answer is lawful.
    const reading = readChunkAcknowledgement(entryDeclaring(300, 128), INGEST_ID, {
      ingestId: INGEST_ID,
      receivedBytes: 200,
    });
    expect(reading).toStrictEqual({ status: "acknowledged", receivedBytes: 200 });
    expect(windowTripwires.totalFiringCount).toBe(0);
  });
});
