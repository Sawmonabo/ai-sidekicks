// The pin refusal is recorded where the person reads it, so it carries only the first 8 bytes of
// each key hash and never a whole hash or a token.
import { describe, expect, it } from "vitest";

import { RelayPinRefusedPayloadSchema } from "../relay.js";

const HASH = "3f".repeat(32);

describe("relay.pin_refused", () => {
  const payload = {
    relayHost: "relay.example.com",
    pinnedSpkiPrefix: HASH.slice(0, 16),
    presentedSpkiPrefix: "0123456789abcdef",
  };

  it("accepts the host and the two 8-byte prefixes", () => {
    expect(RelayPinRefusedPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it("refuses a whole hash where a prefix belongs", () => {
    expect(
      RelayPinRefusedPayloadSchema.safeParse({ ...payload, presentedSpkiPrefix: HASH }).success,
    ).toBe(false);
  });
});
