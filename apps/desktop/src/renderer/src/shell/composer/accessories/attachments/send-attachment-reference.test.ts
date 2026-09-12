// What a send would carry, held to the two rules that decide it: only settled ingests
// mint a reference, and the user's own order is the one that survives.

import { describe, expect, it } from "vitest";

import {
  ATTACHMENT_DELIVERY_HELD_COPY,
  sendAttachmentReference,
} from "./send-attachment-reference.js";
import { derivedTruth, sendingEntry, settledEntry } from "./ingest-entry.test-support.js";

describe("the send attachment reference", () => {
  it("reports nothing where nothing is attached, which is not the same as nothing ready", () => {
    expect(sendAttachmentReference([], [])).toStrictEqual({ disposition: "none" });
  });

  it("carries the settled artifacts in the ledger's own order", () => {
    const reference = sendAttachmentReference(
      [
        settledEntry("complete", {
          localId: "local-1",
          derived: derivedTruth({ artifactId: "artifact-first" }),
        }),
        settledEntry("complete", {
          localId: "local-2",
          derived: derivedTruth({ artifactId: "artifact-second" }),
        }),
      ],
      [],
    );
    expect(reference).toStrictEqual({
      disposition: "held",
      artifactIds: ["artifact-first", "artifact-second"],
      unsettledCount: 0,
    });
  });

  it("counts every entry that has minted nothing rather than shortening the list silently", () => {
    const reference = sendAttachmentReference(
      [
        sendingEntry("ingesting", { localId: "local-1" }),
        sendingEntry("refused", {
          localId: "local-2",
          refusal: { code: "artifact.too_large", detail: "Past the per-attachment bound." },
        }),
        settledEntry("abandoned", { localId: "local-3" }),
        settledEntry("complete", {
          localId: "local-4",
          derived: derivedTruth({ artifactId: "artifact-only" }),
        }),
      ],
      [],
    );
    expect(reference).toStrictEqual({
      disposition: "held",
      artifactIds: ["artifact-only"],
      unsettledCount: 3,
    });
  });

  it("puts a family's artifacts after the carrier's, which is the order they arrived in", () => {
    const reference = sendAttachmentReference(
      [
        settledEntry("complete", {
          derived: derivedTruth({ artifactId: "artifact-from-picker" }),
        }),
      ],
      [
        { artifactId: "artifact-from-pane", mediaType: "image/png", byteLength: 12 },
        { artifactId: "artifact-from-pane-2", mediaType: "image/png", byteLength: 34 },
      ],
    );
    expect(reference).toStrictEqual({
      disposition: "held",
      artifactIds: ["artifact-from-picker", "artifact-from-pane", "artifact-from-pane-2"],
      unsettledCount: 0,
    });
  });

  it("holds a carrier of nothing but unsettled entries, rather than reporting none", () => {
    // The `held` arm with an empty id list is the honest reading of a carrier whose
    // every upload is still running: something IS attached, and none of it can be
    // referenced yet.
    expect(sendAttachmentReference([sendingEntry("declared")], [])).toStrictEqual({
      disposition: "held",
      artifactIds: [],
      unsettledCount: 1,
    });
  });

  it("negative control: the hold says why, rather than being an empty sentence", () => {
    // Without this the copy could be emptied and every case above would still pass —
    // the strip would render a blank line where the reason a settled artifact is not
    // riding this turn belongs.
    expect(ATTACHMENT_DELIVERY_HELD_COPY).toContain("untyped attachment list");
  });
});
