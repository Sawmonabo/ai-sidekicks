// A chip offers a retry only for a refusal that is not of the file itself: the same bytes get the
// same answer, so a control to send them again would promise what cannot happen.

import { describe, expect, it } from "vitest";

import { composerAttachmentChip } from "./chip.js";
import { sendingEntry, settledEntry } from "./ingest-entry.test-support.js";

describe("the attachment chip's retry", () => {
  it("is offered for a refusal sent again in place, and not for one of the file itself", () => {
    const lostResponse = sendingEntry("refused", {
      refusal: { code: "artifact.type_check_unavailable", detail: "The check did not run." },
      disposition: "retry-in-place",
    });
    const refusedFile = settledEntry("refused", {
      refusal: { code: "artifact.type_unreadable", detail: "The detector refused the bytes." },
      disposition: "attach-another",
    });

    expect(composerAttachmentChip(lostResponse, 0).offersRetry).toBe(true);
    expect(composerAttachmentChip(refusedFile, 0).offersRetry).toBe(false);
  });
});
