// What a send would carry: only settled ingests mint a reference, and every entry that minted
// nothing is counted rather than dropped.

import { describe, expect, it } from "vitest";

import { composeSendAttachmentReference } from "./send-attachment-reference.js";
import { derivedTruth, sendingEntry, settledEntry } from "./ingest-entry.test-support.js";

describe("the send attachment reference", () => {
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
});
