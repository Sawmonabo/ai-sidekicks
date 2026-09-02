// The attachment vocabulary, and the one rule that can be proved rather than intended.
//
// §10.8 says "never chart base64 length as progress". `advanceReceivedBytes` is the
// only place a progress figure is produced, and the cases below drive THAT function —
// not a copy of its arithmetic — with an encoded length and assert the
// `wire-figure-formatting` tripwire fires. The negative control is the same call with a
// decoded length, which must fire nothing: without it the assertion would pass over a
// tripwire that fired on every advance.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { INGEST_STREAM_LIFETIME_CEILING_MS, consoleTripwires } from "../core/index.js";
import {
  ATTACHMENT_ALLOWLIST_DEFAULT,
  INGEST_CAPACITY_EXHAUSTED_CODE,
  INGEST_DISPOSITION_COPY,
  INGEST_REFUSAL_DISPOSITIONS,
  INGEST_STREAM_INVALID_CODE,
  UNRESOLVED_ATTACHMENT_CAUSES,
  UNRESOLVED_ATTACHMENT_PRESENTATION,
  advanceReceivedBytes,
  attachmentSourceFrom,
  ingestCeilingRemainingMs,
  ingestRefusalDisposition,
  isIngestStalled,
  type AttachmentIngestEntry,
} from "./attachment-model.js";

/** One entry that has sent nothing, declaring a decoded total of 300 bytes. */
function entryDeclaring(byteLength: number, receivedBytes = 0): AttachmentIngestEntry {
  return {
    declared: attachmentSourceFrom({
      localId: "attachment-1",
      declaredName: "notes.md",
      payload: new Blob([new Uint8Array(byteLength)]),
    }),
    state: "ingesting",
    receivedBytes,
    ingestId: "ingest-1",
    derived: undefined,
    refusal: undefined,
    disposition: undefined,
    openedAtMilliseconds: 1_000,
    lastProgressAtMilliseconds: 1_000,
  };
}

describe("attachment progress — the decoded-byte tripwire", () => {
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

  it("charges a decoded chunk and reports nothing", () => {
    expect(advanceReceivedBytes(entryDeclaring(300), 300)).toBe(300);
    expect(consoleTripwires.firingCount("wire-figure-formatting")).toBe(0);
  });

  it("fires the wire-figure tripwire when a base64 length is charted as progress", () => {
    // 300 decoded bytes encode to 400 base64 characters. Charting the encoded length is
    // the exact defect §10.8 forbids, and it is observable because it drives the total
    // past a figure the caller itself declared.
    expect(advanceReceivedBytes(entryDeclaring(300), 400)).toBe(300);
    expect(consoleTripwires.firingCount("wire-figure-formatting")).toBe(1);
    expect(consoleTripwires.reports()[0]?.site).toBe("repos/attachment-model.ts");
  });

  it("negative control: a partial decoded advance still reports nothing", () => {
    // Without this, the case above would pass over a function that fired on every call.
    expect(advanceReceivedBytes(entryDeclaring(300, 128), 128)).toBe(256);
    expect(consoleTripwires.totalFiringCount).toBe(0);
  });

  it("throws in the loud arm, so an author meets the defect where they caused it", () => {
    consoleTripwires.setThrowOnReport(true);
    expect(() => advanceReceivedBytes(entryDeclaring(300), 400)).toThrow();
    // The record exists on both arms — that is the tripwire contract, and a caught
    // throw that left no evidence would defeat the diagnostic band.
    expect(consoleTripwires.firingCount("wire-figure-formatting")).toBe(1);
  });
});

describe("attachment vocabulary — totality and the two named codes", () => {
  it("gives every unresolved cause its own sentence", () => {
    for (const cause of UNRESOLVED_ATTACHMENT_CAUSES) {
      expect(UNRESOLVED_ATTACHMENT_PRESENTATION[cause].meaning.length).toBeGreaterThan(0);
    }
  });

  it("gives every cause but the deleted one a remedy, and that one none", () => {
    // The design's own asymmetry: five causes lift and one does not, and blanking the
    // difference would imply a way back that is not there.
    expect(UNRESOLVED_ATTACHMENT_PRESENTATION.deleted.remedy).toBeUndefined();
    const withRemedy = UNRESOLVED_ATTACHMENT_CAUSES.filter(
      (cause) => UNRESOLVED_ATTACHMENT_PRESENTATION[cause].remedy !== undefined,
    );
    expect(withRemedy).toStrictEqual([
      "local_only_remote",
      "pending_replication",
      "over_cap",
      "quota_exceeded",
      "expired",
    ]);
  });

  it("keeps the terminal and the transient refusal apart", () => {
    expect(ingestRefusalDisposition(INGEST_STREAM_INVALID_CODE)).toBe("restart");
    expect(ingestRefusalDisposition(INGEST_CAPACITY_EXHAUSTED_CODE)).toBe("wait-and-retry");
  });

  it("negative control: an unrecognised code takes the retry-safe default, not a restart", () => {
    // Collapsing these would tell a participant to re-upload a hundred megabytes
    // because a response was lost, which is the mistake the distinction exists to stop.
    expect(ingestRefusalDisposition("wire-unregistered")).toBe("retry-in-place");
    for (const disposition of INGEST_REFUSAL_DISPOSITIONS) {
      expect(INGEST_DISPOSITION_COPY[disposition].length).toBeGreaterThan(0);
    }
  });

  it("ships the default allow-list without the one image type that is a document", () => {
    expect(ATTACHMENT_ALLOWLIST_DEFAULT).toContain("image/png");
    expect(ATTACHMENT_ALLOWLIST_DEFAULT).not.toContain("image/svg+xml");
  });
});

describe("attachment ceiling and stall", () => {
  it("counts the ceiling down from the moment the stream opened", () => {
    expect(ingestCeilingRemainingMs(entryDeclaring(300), 1_000)).toBe(
      INGEST_STREAM_LIFETIME_CEILING_MS,
    );
    expect(ingestCeilingRemainingMs(entryDeclaring(300), 1_000 + 60_000)).toBe(
      INGEST_STREAM_LIFETIME_CEILING_MS - 60_000,
    );
  });

  it("negative control: an unopened stream has no ceiling to report", () => {
    const unopened = { ...entryDeclaring(300), openedAtMilliseconds: undefined };
    expect(ingestCeilingRemainingMs(unopened, 9_000_000)).toBeUndefined();
  });

  it("calls an upload stalled only after the disclosure window", () => {
    expect(isIngestStalled(entryDeclaring(300), 1_000 + 59_000)).toBe(false);
    expect(isIngestStalled(entryDeclaring(300), 1_000 + 60_000)).toBe(true);
  });

  it("negative control: a complete upload is never stalled", () => {
    const complete = { ...entryDeclaring(300), state: "complete" } as const;
    expect(isIngestStalled(complete, 9_000_000)).toBe(false);
  });
});
