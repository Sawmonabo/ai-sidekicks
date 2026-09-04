// What a surface is told, and the one rule that can be proved rather than intended.
//
// The two instants are the subject: a ceiling and a stall are both answers that MOVE,
// and the module that answers them takes the instant rather than reading a clock, which
// is exactly what makes them assertable at all. The progress figure moved out with the
// function that produces it — the running total is the daemon's, so its cases live in
// `attachment-ingest-acknowledgement.test.ts`.

import { describe, expect, it } from "vitest";

import { INGEST_STREAM_LIFETIME_CEILING_MS } from "../core/index.js";
import { UNRESOLVED_ATTACHMENT_CAUSES } from "./attachment-policy.js";
import {
  UNRESOLVED_ATTACHMENT_PRESENTATION,
  ingestCeilingRemainingMs,
  isIngestStalled,
} from "./attachment-presentation.js";
import {
  attachmentSourceFrom,
  type AttachmentIngestEntry,
  type SettledAttachmentIngestState,
} from "./attachment-shapes.js";

/** One entry that has sent nothing, declaring a decoded total of 300 bytes. */
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
    ingestId: "ingest-1",
    derived: undefined,
    refusal: undefined,
    disposition: undefined,
    openedAtMilliseconds: 1_000,
    lastProgressAtMilliseconds: 1_000,
  };
}

/**
 * The same attachment once its ingest has stopped: metadata, and no payload member.
 *
 * Written out rather than spread from the fixture above, because the settled arm has
 * nowhere to put a `Blob` — a spread of a sending entry does not compile here, which
 * is the release rule holding a test fixture to the same shape it holds the ledger to.
 */
function settledEntry(state: SettledAttachmentIngestState): AttachmentIngestEntry {
  return {
    declared: attachmentSourceFrom({
      localId: "attachment-1",
      declaredName: "notes.md",
      payload: new Blob([new Uint8Array(300)]),
    }).declared,
    state,
    receivedBytes: 0,
    ingestId: "ingest-1",
    derived: undefined,
    refusal: undefined,
    disposition: undefined,
    openedAtMilliseconds: 1_000,
    lastProgressAtMilliseconds: 1_000,
  };
}

describe("unresolved attachment presentation — totality, and the one cause with no way back", () => {
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
    expect(isIngestStalled(settledEntry("complete"), 9_000_000)).toBe(false);
  });
});
