// Neither side gates the other on the media type: a payload the browser could not type still
// shows the daemon's finding, and an agreeing pair collapses to one chip while a disagreement
// keeps both with the derived one leading. The derived name replaces the declaration outright,
// and the face and the accessible label read the one function.

import type { ArtifactId } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { attachmentMediaTypeReadings, attachmentNameReading } from "./attachment-provenance.js";
import { attachmentSourceFrom, type AttachmentIngestEntry } from "./attachment-shapes.js";

describe("attachment media type — which readings the card is given", () => {
  function ingestEntry(
    declaredMediaType: string | undefined,
    mimeType: string | undefined,
  ): AttachmentIngestEntry {
    return {
      ...attachmentSourceFrom({
        localId: "attachment-1",
        declaredName: "screenshot.png",
        payload: new Blob([new Uint8Array(4)]),
        ...(declaredMediaType === undefined ? {} : { declaredMediaType }),
      }),
      state: "ingesting",
      receivedBytes: 0,
      ingestId: "ingest-1",
      derived:
        mimeType === undefined
          ? undefined
          : {
              artifactId: "artifact-1" as ArtifactId,
              fileName: "screenshot.png",
              mimeType,
              sizeBytes: 4,
            },
      refusal: undefined,
      disposition: undefined,
      openedAtMilliseconds: 0,
      lastProgressAtMilliseconds: 0,
    };
  }

  it("reports the derived reading where the client declared nothing", () => {
    expect(attachmentMediaTypeReadings(ingestEntry(undefined, "image/png"))).toEqual([
      { mediaType: "image/png", provenance: "derived" },
    ]);
  });

  it("reports the declaration where nothing has been derived yet", () => {
    expect(attachmentMediaTypeReadings(ingestEntry("image/png", undefined))).toEqual([
      { mediaType: "image/png", provenance: "declared" },
    ]);
  });

  it("collapses an agreeing pair to the derived reading alone", () => {
    expect(attachmentMediaTypeReadings(ingestEntry("image/png", "image/png"))).toEqual([
      { mediaType: "image/png", provenance: "derived" },
    ]);
  });

  it("leads with the derived reading and keeps the declaration where they disagree", () => {
    expect(attachmentMediaTypeReadings(ingestEntry("text/plain", "image/png"))).toEqual([
      { mediaType: "image/png", provenance: "derived" },
      { mediaType: "text/plain", provenance: "declared" },
    ]);
  });

  it("negative control: neither reading present yields no reading at all", () => {
    // Without this a function that always answered something would put an empty chip on an
    // untyped attachment.
    expect(attachmentMediaTypeReadings(ingestEntry(undefined, undefined))).toEqual([]);
  });
});

describe("attachment name — the derived name replaces the declaration", () => {
  /** One entry declaring a name, with the daemon's finding present or not. */
  function namedEntry(declaredName: string, fileName: string | undefined): AttachmentIngestEntry {
    return {
      ...attachmentSourceFrom({
        localId: "attachment-1",
        declaredName,
        payload: new Blob([new Uint8Array(8)]),
      }),
      state: fileName === undefined ? "ingesting" : "complete",
      receivedBytes: 8,
      ingestId: "ingest-1",
      derived:
        fileName === undefined
          ? undefined
          : {
              artifactId: "artifact-1" as ArtifactId,
              fileName,
              mimeType: "text/plain",
              sizeBytes: 8,
            },
      refusal: undefined,
      disposition: undefined,
      openedAtMilliseconds: 1_000,
      lastProgressAtMilliseconds: 1_000,
    } as AttachmentIngestEntry;
  }

  it("answers the daemon's normalized name once one exists", () => {
    expect(attachmentNameReading(namedEntry("../../etc/passwd", "passwd"))).toStrictEqual({
      name: "passwd",
      provenance: "derived",
    });
  });

  it("negative control: before the daemon has read a byte, the declaration is the name", () => {
    // Without this, always answering the derived member would report an absent name on every
    // in-flight attachment.
    expect(attachmentNameReading(namedEntry("notes.md", undefined))).toStrictEqual({
      name: "notes.md",
      provenance: "declared",
    });
  });
});
