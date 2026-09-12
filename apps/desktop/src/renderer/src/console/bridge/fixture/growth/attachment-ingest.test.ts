// The ingest stand-in, held to the protocol rather than to its own answers.
//
// Every case here is a rule the daemon states and the console's own client depends on:
// the running total the next chunk's offset is read from, the replay that is
// acknowledged without being appended, the completion that replays verbatim, and the
// four refusals raised at the enforcement points the contract names. The negative controls
// are what keep a stand-in that simply said `served` from passing.

import { describe, expect, it } from "vitest";

import {
  ATTACHMENTS_PER_CARRIER_CAP_DEFAULT,
  ATTACHMENT_BYTE_CAP_DEFAULT,
  encodeBase64,
} from "../../../core/index.js";
import { FixtureAttachmentIngest } from "./attachment-ingest.js";

const SESSION_ID = "019b7a11-1100-7e00-8110-e5e0c1150000";

/** One chunk carrying exactly this many raw bytes, encoded the way the client encodes. */
function chunkOf(byteLength: number): string {
  return encodeBase64(new Uint8Array(byteLength));
}

/** What was refused, read off the envelope the stand-in throws. */
function refusalCodeOf(act: () => unknown): string {
  try {
    act();
  } catch (thrown: unknown) {
    return (thrown as { readonly code: string }).code;
  }
  return "nothing-was-refused";
}

describe("the fixture ingest spool", () => {
  it("acknowledges the spooled running total, which is what the offset is read from", () => {
    const spools = new FixtureAttachmentIngest();
    const { ingestId } = spools.begin({
      sessionId: SESSION_ID,
      fileName: "notes.md",
      declaredSizeBytes: 300,
    });
    expect(spools.writeChunk({ ingestId, sequenceNumber: 0, chunk: chunkOf(100) })).toStrictEqual({
      ingestId,
      receivedBytes: 100,
    });
    expect(spools.writeChunk({ ingestId, sequenceNumber: 1, chunk: chunkOf(120) })).toStrictEqual({
      ingestId,
      receivedBytes: 220,
    });
  });

  it("acknowledges a replayed chunk without appending it twice", () => {
    const spools = new FixtureAttachmentIngest();
    const { ingestId } = spools.begin({
      sessionId: SESSION_ID,
      fileName: "notes.md",
      declaredSizeBytes: 300,
    });
    spools.writeChunk({ ingestId, sequenceNumber: 0, chunk: chunkOf(100) });
    const replayed = spools.writeChunk({ ingestId, sequenceNumber: 0, chunk: chunkOf(100) });
    expect(replayed.receivedBytes).toBe(100);
  });

  it("replaces the declaration with a derived truth, and replays that completion verbatim", () => {
    const spools = new FixtureAttachmentIngest();
    const { ingestId } = spools.begin({
      sessionId: SESSION_ID,
      // A name the daemon would normalize and a declared type that disagrees with what
      // the payload is placed as, so both provenance arms are reachable from a fixture.
      fileName: "Meeting Notes.MD",
      mediaType: "text/plain",
      declaredSizeBytes: 40,
    });
    spools.writeChunk({ ingestId, sequenceNumber: 0, chunk: chunkOf(40) });
    const completion = spools.complete({ ingestId });
    expect(completion.normalizedName).toBe("meeting-notes.md");
    expect(completion.derivedMediaType).toBe("text/markdown");
    expect(completion.derivedSizeBytes).toBe(40);
    expect(spools.complete({ ingestId })).toStrictEqual(completion);
  });

  it("refuses a declared size past the per-attachment bound before opening a stream", () => {
    const spools = new FixtureAttachmentIngest();
    expect(
      refusalCodeOf(() =>
        spools.begin({
          sessionId: SESSION_ID,
          fileName: "capture.png",
          declaredSizeBytes: ATTACHMENT_BYTE_CAP_DEFAULT + 1,
        }),
      ),
    ).toBe("artifact.too_large");
  });

  it("refuses a chunk that pushes the running total past the declaration", () => {
    const spools = new FixtureAttachmentIngest();
    const { ingestId } = spools.begin({
      sessionId: SESSION_ID,
      fileName: "notes.md",
      declaredSizeBytes: 100,
    });
    expect(
      refusalCodeOf(() => spools.writeChunk({ ingestId, sequenceNumber: 0, chunk: chunkOf(101) })),
    ).toBe("artifact.too_large");
  });

  it("refuses the whole carrier once the count bound is reached, keeping earlier artifacts", () => {
    const spools = new FixtureAttachmentIngest();
    const mintedArtifactIds: string[] = [];
    for (let attached = 0; attached < ATTACHMENTS_PER_CARRIER_CAP_DEFAULT; attached += 1) {
      const { ingestId } = spools.begin({
        sessionId: SESSION_ID,
        fileName: `note-${String(attached)}.md`,
        declaredSizeBytes: 8,
      });
      spools.writeChunk({ ingestId, sequenceNumber: 0, chunk: chunkOf(8) });
      mintedArtifactIds.push(spools.complete({ ingestId }).artifactId);
    }
    expect(
      refusalCodeOf(() =>
        spools.begin({ sessionId: SESSION_ID, fileName: "one-too-many.md", declaredSizeBytes: 8 }),
      ),
    ).toBe("artifact.too_many_attachments");
    expect(new Set(mintedArtifactIds).size).toBe(ATTACHMENTS_PER_CARRIER_CAP_DEFAULT);
  });

  it("refuses a payload it cannot place, rather than re-typing it as the caller's claim", () => {
    const spools = new FixtureAttachmentIngest();
    const { ingestId } = spools.begin({
      sessionId: SESSION_ID,
      fileName: "diagram.svg",
      mediaType: "image/png",
      declaredSizeBytes: 8,
    });
    spools.writeChunk({ ingestId, sequenceNumber: 0, chunk: chunkOf(8) });
    expect(refusalCodeOf(() => spools.complete({ ingestId }))).toBe(
      "artifact.unsupported_media_type",
    );
  });

  it("ends a stream that took a chunk out of sequence, and one that names no spool", () => {
    const spools = new FixtureAttachmentIngest();
    const { ingestId } = spools.begin({
      sessionId: SESSION_ID,
      fileName: "notes.md",
      declaredSizeBytes: 300,
    });
    expect(
      refusalCodeOf(() => spools.writeChunk({ ingestId, sequenceNumber: 3, chunk: chunkOf(8) })),
    ).toBe("artifact.ingest_stream_invalid");
    // Terminal: the spool is gone, so resuming it refuses under the same code.
    expect(
      refusalCodeOf(() => spools.writeChunk({ ingestId, sequenceNumber: 0, chunk: chunkOf(8) })),
    ).toBe("artifact.ingest_stream_invalid");
  });

  it("gives a spool back without refusing, including one already reclaimed", () => {
    const spools = new FixtureAttachmentIngest();
    const { ingestId } = spools.begin({
      sessionId: SESSION_ID,
      fileName: "notes.md",
      declaredSizeBytes: 8,
    });
    expect(() => {
      spools.abort({ ingestId });
      spools.abort({ ingestId });
    }).not.toThrow();
  });

  it("negative control: an abandoned spool is gone rather than still completable", () => {
    // Without this, an `abort` that recorded nothing would pass every case above.
    const spools = new FixtureAttachmentIngest();
    const { ingestId } = spools.begin({
      sessionId: SESSION_ID,
      fileName: "notes.md",
      declaredSizeBytes: 8,
    });
    spools.abort({ ingestId });
    expect(refusalCodeOf(() => spools.complete({ ingestId }))).toBe(
      "artifact.ingest_stream_invalid",
    );
  });
});
