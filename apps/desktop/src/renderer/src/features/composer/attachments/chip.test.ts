// A chip offers a retry only for a refusal that is not of the file itself: the same bytes get the
// same answer, so a control to send them again would promise what cannot happen.

import { describe, expect, it } from "vitest";

import { composerAttachmentChip } from "./chip.js";
import { sendingEntry, settledEntry } from "./ingest-entry.test-support.js";

describe("the attachment chip's retry", () => {
  it("is offered for a refusal that may be sent again, and not for one of the file itself", () => {
    const busyIngest = sendingEntry("refused", {
      refusal: { code: "artifact.ingest.capacityExhausted", detail: "The ingest is busy." },
      disposition: "wait-and-retry",
    });
    const refusedFile = settledEntry("refused", {
      refusal: { code: "artifact.tooLarge", detail: "The disk has no room for it." },
      disposition: "attach-another",
    });

    expect(composerAttachmentChip(busyIngest, 0).offersRetry).toBe(true);
    expect(composerAttachmentChip(refusedFile, 0).offersRetry).toBe(false);
  });
});
