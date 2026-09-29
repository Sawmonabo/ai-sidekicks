// The refusal a surface reads is the one the daemon spoke, not the seam wrapper around it.

import { describe, expect, it } from "vitest";

import { refuse } from "@renderer/lib/refusal.js";
import { daemonSpokenRefusal } from "./artifact-refusal-copy.js";

describe("daemonSpokenRefusal — the code the daemon spoke, not the one that arrived", () => {
  it("reads through a seam refusal that carries the daemon's own on its cause", () => {
    // A call layer may answer a REJECTED call with its own `call-rejected` and the
    // normalized daemon refusal on `cause`. The daemon's `artifact.*` code is on the
    // cause, so a read of the outer code alone would miss it.
    const cause = refuse("daemon", "artifact.fetch_unauthorized", "The fetch was not authorized.");
    const arrived = {
      ...refuse("repos", "call-rejected", "artifact read did not answer"),
      cause,
    };
    expect(daemonSpokenRefusal(arrived)).toBe(cause);
    expect(daemonSpokenRefusal(arrived).code).toBe("artifact.fetch_unauthorized");
  });

  it("negative control: a refusal with no cause is its own spoken refusal", () => {
    // A served refusal carries the dotted code directly, so unwrapping must be a
    // no-op there rather than an absence the surfaces have to branch on.
    const served = refuse("daemon", "artifact.relay_expired", "Blob is gone.");
    expect(daemonSpokenRefusal(served)).toBe(served);
  });
});
