// The attachment names the composer reads from the repos entry.

import { describe, expect, it } from "vitest";

import * as reposDoorModule from "./index.js";

describe("repos — the attachment names the composer reads", () => {
  it("publishes the attachment carrier through the door", () => {
    // The composer's attachment affordance is a sibling view family, so the door is
    // the only way across — and it publishes the BINDING rather than the raw ingest
    // client, so a second carrier over one session cannot be constructed by hand.
    expect(typeof reposDoorModule.useAttachmentCarrier).toBe("function");
  });

  it("negative control: the door publishes no body the family does not own", () => {
    // Without this the case above would pass over a barrel that re-exported the whole
    // family, which is what the one-door rule exists to prevent.
    const doorExports = Object.keys(reposDoorModule);
    expect(doorExports).not.toContain("RestorePathList");
    expect(doorExports).not.toContain("AttachmentCard");
  });
});
