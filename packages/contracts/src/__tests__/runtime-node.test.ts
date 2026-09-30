// A machine's DNS challenge request is the one way it gets the relay to write a DNS
// record, so the request's name must be an ACME challenge name and nothing else.
import { describe, expect, it } from "vitest";

import { RuntimeNodeCertificateChallengeSetRequestSchema } from "../runtime-node.js";

describe("runtimenode.certificateChallengeSet", () => {
  const value = "x".repeat(43);

  it("accepts a challenge record under the machine's name", () => {
    expect(
      RuntimeNodeCertificateChallengeSetRequestSchema.safeParse({
        name: "_acme-challenge.mac-mini.relay.example.com",
        value,
      }).success,
    ).toBe(true);
  });

  it("refuses to write any record that is not a challenge", () => {
    expect(
      RuntimeNodeCertificateChallengeSetRequestSchema.safeParse({
        name: "www.relay.example.com",
        value,
      }).success,
    ).toBe(false);
  });
});
