// One chip's line, held to the rules the chip and the transcript card must not answer
// differently: whose name is on it, which reading is the truth, what a refusal recommends,
// and which acts an entry in this state offers.

import { describe, expect, it } from "vitest";

import { INGEST_ABANDON_COPY } from "./attachment-policy.js";
import { composerAttachmentChip } from "./composer-attachment-chip.js";
import { derivedTruth, sendingEntry, settledEntry } from "./ingest-entry.test-support.js";

/** Fixed, so nothing here reads a clock. */
const PUBLISHED_AT = 1_000_000;

describe("the composer attachment chip", () => {
  it("shows the caller's own claim as a claim until the daemon has read the bytes", () => {
    const chip = composerAttachmentChip(
      sendingEntry("ingesting", {
        declaredName: "Meeting Notes.MD",
        declaredMediaType: "text/plain",
        byteLength: 400,
        receivedBytes: 100,
      }),
      PUBLISHED_AT,
    );
    expect(chip.name).toBe("Meeting Notes.MD");
    expect(chip.nameIsDeclared).toBe(true);
    expect(chip.mediaType).toBe("text/plain");
    expect(chip.mediaTypeQualifier).toBeDefined();
  });

  it("replaces the declaration with the finding once one exists", () => {
    const chip = composerAttachmentChip(
      settledEntry("complete", {
        declaredName: "Meeting Notes.MD",
        declaredMediaType: "text/plain",
        byteLength: 400,
        derived: derivedTruth({
          fileName: "meeting-notes.md",
          mimeType: "text/markdown",
          sizeBytes: 420,
        }),
      }),
      PUBLISHED_AT,
    );
    expect(chip.name).toBe("meeting-notes.md");
    expect(chip.nameIsDeclared).toBe(false);
    // The derived length, not the declared 400: the caller's word must not stand as the manifest's.
    expect(chip.sizeTitle).toBe("420");
  });

  it("draws progress only while bytes are moving", () => {
    expect(
      composerAttachmentChip(
        sendingEntry("ingesting", { byteLength: 400, receivedBytes: 100 }),
        PUBLISHED_AT,
      ).progressFraction,
    ).toBeCloseTo(0.25);
    // A bar drawn at zero for a refused upload reads as one about to start.
    expect(
      composerAttachmentChip(
        sendingEntry("refused", {
          refusal: { code: "artifact.too_large", detail: "Past the bound." },
        }),
        PUBLISHED_AT,
      ).progressFraction,
    ).toBeUndefined();
    // An empty payload has no progress to draw; dividing by its length would invent a figure.
    expect(
      composerAttachmentChip(
        sendingEntry("ingesting", { byteLength: 0, receivedBytes: 0 }),
        PUBLISHED_AT,
      ).progressFraction,
    ).toBeUndefined();
  });

  it("carries the refusal verbatim beside what its disposition recommends", () => {
    const chip = composerAttachmentChip(
      sendingEntry("refused", {
        refusal: { code: "artifact.ingest_stream_invalid", detail: "This stream is over." },
        disposition: "restart",
      }),
      PUBLISHED_AT,
    );
    expect(chip.refusal?.code).toBe("artifact.ingest_stream_invalid");
    expect(chip.refusal?.detail).toBe("This stream is over.");
    expect(chip.refusal?.disposition).toContain("from the first byte");
    expect(chip.tone).toBe("failure");
  });

  it("offers a retry only where one can be taken, and a cancel only while one is open", () => {
    const refused = composerAttachmentChip(
      sendingEntry("refused", {
        refusal: { code: "artifact.too_large", detail: "Past the bound." },
      }),
      PUBLISHED_AT,
    );
    expect(refused.offersRetry).toBe(true);
    expect(refused.offersAbandon).toBe(false);
    const running = composerAttachmentChip(sendingEntry("ingesting"), PUBLISHED_AT);
    expect(running.offersRetry).toBe(false);
    expect(running.offersAbandon).toBe(true);
    const done = composerAttachmentChip(
      settledEntry("complete", { derived: derivedTruth() }),
      PUBLISHED_AT,
    );
    expect(done.offersRetry).toBe(false);
    expect(done.offersAbandon).toBe(false);
  });

  it("says what canceling does in the daemon's own terms, never as `canceled`", () => {
    const chip = composerAttachmentChip(sendingEntry("ingesting"), PUBLISHED_AT);
    expect(chip.abandonCopy).toBe(INGEST_ABANDON_COPY);
    expect(chip.abandonCopy).toContain("cleaned up shortly");
  });

  it("stays neutral for a file past the byte bound, because the upload is still attempted", () => {
    // Color means identity and attention, and a bound the daemon owns is neither.
    const chip = composerAttachmentChip(
      sendingEntry("declared", { byteLength: 1024 * 1024 * 1024 }),
      PUBLISHED_AT,
    );
    expect(chip.isPastByteAllowance).toBe(true);
    expect(chip.tone).toBe("neutral");
  });

  it("negative control: an ordinary attachment is not reported past the byte bound", () => {
    // Without this, an `isPastByteAllowance` hard-wired to `true` would pass the case above.
    expect(
      composerAttachmentChip(sendingEntry("declared", { byteLength: 1024 }), PUBLISHED_AT)
        .isPastByteAllowance,
    ).toBe(false);
  });
});
