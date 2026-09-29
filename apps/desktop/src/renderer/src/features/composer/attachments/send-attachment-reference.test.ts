// What a send would carry, held to the two rules that decide it: only settled ingests
// mint a reference, and the user's own order is the one that survives.

import { describe, expect, it } from "vitest";

import { composeSendAttachmentReference } from "./send-attachment-reference.js";
import { derivedTruth, sendingEntry, settledEntry } from "./ingest-entry.test-support.js";

describe("the send attachment reference", () => {
  it("reports nothing where nothing is attached, which is not the same as nothing ready", () => {
    expect(composeSendAttachmentReference([])).toStrictEqual({ disposition: "none" });
  });

  it("carries the settled artifacts in the ledger's own order", () => {
    const reference = composeSendAttachmentReference([
      settledEntry("complete", {
        localId: "local-1",
        derived: derivedTruth({ artifactId: "artifact-first" }),
      }),
      settledEntry("complete", {
        localId: "local-2",
        derived: derivedTruth({ artifactId: "artifact-second" }),
      }),
    ]);
    expect(reference).toStrictEqual({
      disposition: "held",
      artifactIds: ["artifact-first", "artifact-second"],
      unsettledCount: 0,
    });
  });

  it("counts every entry that has minted nothing rather than shortening the list silently", () => {
    const reference = composeSendAttachmentReference([
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
    ]);
    expect(reference).toStrictEqual({
      disposition: "held",
      artifactIds: ["artifact-only"],
      unsettledCount: 3,
    });
  });

  it("holds a staged list of nothing but unsettled entries, rather than reporting none", () => {
    // The `held` arm with an empty id list is the honest reading of a staged list whose
    // every upload is still running: something IS attached, and none of it can be
    // referenced.
    expect(composeSendAttachmentReference([sendingEntry("declared")])).toStrictEqual({
      disposition: "held",
      artifactIds: [],
      unsettledCount: 1,
    });
  });
});
