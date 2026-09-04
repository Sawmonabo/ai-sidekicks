// Which media-type readings a card is given, and whose each one is.
//
// The rule under test is that NEITHER side gates the other: a payload the browser could
// not type still shows the daemon's finding, and a declaration with nothing derived yet
// still shows. The two cases where both exist are the interesting ones — an agreeing
// pair collapses to one chip rather than printing the same string twice, and a
// disagreement keeps both with the derived reading leading.

import { describe, expect, it } from "vitest";

import { attachmentMediaTypeReadings } from "./attachment-media-type.js";
import { attachmentSourceFrom, type AttachmentIngestEntry } from "./attachment-shapes.js";

describe("attachment media type — which readings the card is given", () => {
  function ingestEntry(
    declaredMediaType: string | undefined,
    derivedMediaType: string | undefined,
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
        derivedMediaType === undefined
          ? undefined
          : {
              artifactId: "artifact-1",
              normalizedName: "screenshot.png",
              derivedMediaType,
              derivedSizeBytes: 4,
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
    // Without this, a function that always answered with something would satisfy every
    // case above and would put an empty chip on an attachment nobody has typed.
    expect(attachmentMediaTypeReadings(ingestEntry(undefined, undefined))).toEqual([]);
  });
});
