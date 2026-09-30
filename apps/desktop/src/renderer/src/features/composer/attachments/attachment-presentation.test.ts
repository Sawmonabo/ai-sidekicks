// The ceiling and the stall are answers that move, so the module takes the instant rather than
// reading a clock, which makes them assertable. The progress figure's cases live in
// `services/attachment-ingest-acknowledgement.test.ts`.

import { SESSION_ATTACHMENT_UNRESOLVED_CAUSES } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { INGEST_STREAM_LIFETIME_CEILING_MS } from "./attachment-caps.js";
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

/** One entry that has sent nothing, declaring `byteLength` decoded bytes. */
function entryDeclaring(byteLength: number, receivedBytes = 0): AttachmentIngestEntry {
  return {
    // Spread because a source is the two members an entry carries: the declaration and bytes.
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
 * The same attachment once its ingest has stopped: metadata and no payload member. Written out
 * rather than spread, since a spread of a sending entry does not compile against the settled arm.
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
    for (const cause of SESSION_ATTACHMENT_UNRESOLVED_CAUSES) {
      expect(UNRESOLVED_ATTACHMENT_PRESENTATION[cause].meaning.length).toBeGreaterThan(0);
    }
  });

  it("gives every cause but the deleted one a remedy, and that one none", () => {
    // Five causes lift and one does not; blanking the difference would imply a way back.
    expect(UNRESOLVED_ATTACHMENT_PRESENTATION.deleted.remedy).toBeUndefined();
    const withRemedy = SESSION_ATTACHMENT_UNRESOLVED_CAUSES.filter(
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
