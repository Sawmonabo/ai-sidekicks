// Every machine verifies the account's statement chain itself, so a statement that
// parses here is what a verifier is handed. These tests hold that a key's length
// matches its algorithm.
import { describe, expect, it } from "vitest";

import { IdentityPublicKeySchema } from "../trust-statement.js";
import { base64Bytes, P256_KEY } from "./trust-statement.test-support.js";

const ED25519_KEY = { algorithm: "ed25519", publicKey: base64Bytes(32) } as const;

describe("identity keys", () => {
  it("accepts each algorithm at its own key length", () => {
    expect(IdentityPublicKeySchema.safeParse(P256_KEY).success).toBe(true);
    expect(IdentityPublicKeySchema.safeParse(ED25519_KEY).success).toBe(true);
  });

  it("refuses a key whose length is not its algorithm's", () => {
    expect(
      IdentityPublicKeySchema.safeParse({ algorithm: "ed25519", publicKey: base64Bytes(65) })
        .success,
    ).toBe(false);
  });
});
