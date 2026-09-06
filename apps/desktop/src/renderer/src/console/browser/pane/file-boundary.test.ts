// Reading the trust-envelope refusal, wherever the normalizer put the code.
//
// Two positions, because the console's refusal grammar has two: the daemon's own
// dotted code on a refusal, and the same code carried on `cause` where a growth
// refusal wrapped the call's rejection. A reader that checked one would render the
// admitted-root disclosure for half the refusals that need it, and neither half is
// the one a person hits more often.

import { describe, expect, it } from "vitest";

import { refuse } from "../../core/index.js";
import { OUTSIDE_TRUST_ENVELOPE_CODE, isOutsideTrustEnvelope } from "./file-boundary.js";

describe("the file-boundary refusal", () => {
  it("recognises the daemon's own code", () => {
    expect(isOutsideTrustEnvelope(refuse("browser", OUTSIDE_TRUST_ENVELOPE_CODE, "no"))).toBe(true);
  });

  it("recognises it under a growth refusal that carried the cause", () => {
    const wrapped = {
      ...refuse("growth-port", "growth.wire_unregistered", "the wire is on the slate"),
      cause: refuse("daemon", OUTSIDE_TRUST_ENVELOPE_CODE, "outside the envelope"),
    };
    expect(isOutsideTrustEnvelope(wrapped)).toBe(true);
  });

  it("does not recognise a different refusal", () => {
    expect(isOutsideTrustEnvelope(refuse("browser", "repo.not_found", "no such repo"))).toBe(false);
  });

  it("reads nothing off an absent refusal", () => {
    expect(isOutsideTrustEnvelope(undefined)).toBe(false);
  });
});
