// What one chunk acknowledgement establishes, driven directly rather than through the
// protocol that consumes it.
//
// The rule this module carries from its old home is that a base64 length is never
// charted as progress: 300 decoded bytes encode to 400 characters, so a total charted
// from the encoded string drives past a bound the caller itself declared, which is
// impossible for a decoded count. The cases below drive THAT function — not a copy of
// its arithmetic — and the negative control is the same call with a lawful total, which
// must fire nothing.
//
// The three unusable arms are the new claim, and each is a fact about the reply rather
// than about its status: no total at all, a total for another stream, and a total that
// did not advance. The last is also what makes the chunk loop terminate — the ledger IS
// the offset — so it is asserted here and again against the real loop next door.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { consoleTripwires } from "../core/index.js";
import {
  ATTACHMENT_ACKNOWLEDGEMENT_SITE,
  readChunkAcknowledgement,
} from "./attachment-ingest-acknowledgement.js";
import { attachmentSourceFrom, type AttachmentIngestEntry } from "./attachment-shapes.js";

/** The stream every case here acknowledges against. */
const INGEST_ID = "ingest-1";

/** One in-flight entry declaring a decoded total, standing at a given offset. */
function entryDeclaring(byteLength: number, receivedBytes = 0): AttachmentIngestEntry {
  return {
    // Spread, because a source IS the two members an entry carries about what it was
    // handed: the declaration and the bytes it describes.
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
  // The process-wide registry throws in a development build, which is what an author
  // should see. These cases assert the RECORD, so they read it in the recording arm
  // and put the configuration back afterwards.
  consoleTripwires.setThrowOnReport(false);
  consoleTripwires.reset();
});

afterEach(() => {
  consoleTripwires.reset();
  consoleTripwires.setThrowOnReport(import.meta.env.DEV);
});

describe("chunk acknowledgement — the offset is the daemon's", () => {
  it("takes the daemon's running total rather than what this client sent", () => {
    // The bug, exercised at the seam: the ledger used to add the local slice length,
    // so a daemon that had spooled a different amount was never contradicted because
    // it was never read. A partial answer is a lawful one — the total is what it is.
    const reading = readChunkAcknowledgement(entryDeclaring(300, 128), INGEST_ID, {
      ingestId: INGEST_ID,
      receivedBytes: 200,
    });
    expect(reading).toStrictEqual({ status: "acknowledged", receivedBytes: 200 });
    expect(consoleTripwires.totalFiringCount).toBe(0);
  });

  it("refuses an acknowledgement that names another stream", () => {
    const reading = readChunkAcknowledgement(entryDeclaring(300), INGEST_ID, {
      ingestId: "ingest-7",
      receivedBytes: 300,
    });
    expect(reading.status).toBe("unusable");
    // Both streams are named, because a sentence saying only that something is wrong
    // leaves a reader unable to say which upload the reply belonged to.
    expect(reading.status === "unusable" ? reading.detail : "").toContain("ingest-7");
    expect(reading.status === "unusable" ? reading.detail : "").toContain(INGEST_ID);
  });

  it("refuses a total that regressed behind the ledger", () => {
    const reading = readChunkAcknowledgement(entryDeclaring(300, 200), INGEST_ID, {
      ingestId: INGEST_ID,
      receivedBytes: 128,
    });
    expect(reading.status).toBe("unusable");
  });

  it("refuses a total that did not advance, which is what ends the chunk loop", () => {
    // Not merely a regression: the ledger is the offset, so a standing total re-slices
    // from the same place for as long as the daemon keeps answering.
    const reading = readChunkAcknowledgement(entryDeclaring(300, 128), INGEST_ID, {
      ingestId: INGEST_ID,
      receivedBytes: 128,
    });
    expect(reading.status).toBe("unusable");
  });

  it("refuses a served reply that carries no acknowledgement at all", () => {
    // The declared type does not make this impossible: the live port is one process
    // boundary away, so what arrives is whatever was sent.
    const reading = readChunkAcknowledgement(entryDeclaring(300), INGEST_ID, undefined);
    expect(reading.status).toBe("unusable");
  });

  it("fires the wire-figure tripwire when an encoded length is acknowledged as progress", () => {
    // 300 decoded bytes encode to 400 base64 characters, and a total charted from the
    // encoded string is observable because it passes a figure the caller declared.
    const reading = readChunkAcknowledgement(entryDeclaring(300), INGEST_ID, {
      ingestId: INGEST_ID,
      receivedBytes: 400,
    });
    expect(reading).toStrictEqual({ status: "acknowledged", receivedBytes: 300 });
    expect(consoleTripwires.firingCount("wire-figure-formatting")).toBe(1);
    expect(consoleTripwires.reports()[0]?.site).toBe(ATTACHMENT_ACKNOWLEDGEMENT_SITE);
  });

  it("negative control: a lawful total reports nothing and is taken verbatim", () => {
    // Without this, every case above would pass over a function that fired on every
    // call or refused every answer it was handed.
    const reading = readChunkAcknowledgement(entryDeclaring(300, 128), INGEST_ID, {
      ingestId: INGEST_ID,
      receivedBytes: 300,
    });
    expect(reading).toStrictEqual({ status: "acknowledged", receivedBytes: 300 });
    expect(consoleTripwires.totalFiringCount).toBe(0);
  });

  it("throws in the loud arm, so an author meets the defect where they caused it", () => {
    consoleTripwires.setThrowOnReport(true);
    expect(() =>
      readChunkAcknowledgement(entryDeclaring(300), INGEST_ID, {
        ingestId: INGEST_ID,
        receivedBytes: 400,
      }),
    ).toThrow();
    // The record exists on both arms — that is the tripwire contract, and a caught
    // throw that left no evidence would defeat the diagnostic band.
    expect(consoleTripwires.firingCount("wire-figure-formatting")).toBe(1);
  });
});
