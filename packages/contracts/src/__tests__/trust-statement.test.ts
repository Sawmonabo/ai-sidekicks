// Every machine verifies the account's statement chain itself, so a statement that
// parses here is what a verifier is handed. These tests hold that a key's length
// matches its algorithm.
import { describe, expect, it } from "vitest";

import { IdentityPublicKeySchema } from "../trust-statement.js";

const bytes = (length: number): string => Buffer.alloc(length, 7).toString("base64");

const ED25519_KEY = { algorithm: "ed25519", publicKey: bytes(32) } as const;
const P256_KEY = { algorithm: "p256", publicKey: bytes(65) } as const;

describe("identity keys", () => {
  it("accepts each algorithm at its own key length", () => {
    expect(IdentityPublicKeySchema.safeParse(P256_KEY).success).toBe(true);
    expect(IdentityPublicKeySchema.safeParse(ED25519_KEY).success).toBe(true);
  });

  it("refuses a key whose length is not its algorithm's", () => {
    expect(
      IdentityPublicKeySchema.safeParse({ algorithm: "ed25519", publicKey: bytes(65) }).success,
    ).toBe(false);
  });
});
