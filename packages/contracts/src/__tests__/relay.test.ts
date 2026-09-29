// The pin refusal is recorded where the person reads it, so it must carry only key
// prefixes and never a whole hash or a token; the repin takes the whole new hash.
import { describe, expect, it } from "vitest";

import { RelayPinRefusedPayloadSchema, RelayRepinRequestSchema } from "../relay.js";

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

describe("relay.repin", () => {
  it("accepts the pasted SHA-256", () => {
    expect(RelayRepinRequestSchema.safeParse({ spkiHash: HASH }).success).toBe(true);
  });

  it("refuses a hash that is not a whole SHA-256 in lowercase hex", () => {
    expect(RelayRepinRequestSchema.safeParse({ spkiHash: HASH.slice(0, 16) }).success).toBe(false);
    expect(RelayRepinRequestSchema.safeParse({ spkiHash: HASH.toUpperCase() }).success).toBe(false);
  });
});
