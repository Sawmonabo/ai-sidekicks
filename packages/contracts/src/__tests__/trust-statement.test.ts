// Every machine verifies the account's statement chain itself, so a statement that
// parses here is what a verifier is handed. These tests hold that a key's length
// matches its algorithm and that a key rotation carries two signatures.
import { describe, expect, it } from "vitest";

import { IdentityPublicKeySchema, TrustStatementSchema } from "../trust-statement.js";

const bytes = (length: number): string => Buffer.alloc(length, 7).toString("base64");

const HASH = "a".repeat(64);
const ISSUED_AT = "2026-09-12T10:00:00.000Z";
const NODE_ID = "mac-mini";
const ED25519_KEY = { algorithm: "ed25519", publicKey: bytes(32) } as const;
const P256_KEY = { algorithm: "p256", publicKey: bytes(65) } as const;
const CHANNEL_KEY = { algorithm: "x25519", publicKey: bytes(32) } as const;
const MACHINE_SIGNATURE = { signer: "runtimenode", nodeId: NODE_ID, signature: bytes(64) };

const keyRotated = {
  kind: "runtimenode.key_rotated",
  previousHash: HASH,
  issuedAt: ISSUED_AT,
  signatures: [MACHINE_SIGNATURE, { ...MACHINE_SIGNATURE, signature: bytes(64) }],
  nodeId: NODE_ID,
  identityKey: ED25519_KEY,
  channelKey: CHANNEL_KEY,
};

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

describe("the statement chain", () => {
  it("refuses a key rotation signed by one key alone", () => {
    expect(TrustStatementSchema.safeParse(keyRotated).success).toBe(true);
    expect(
      TrustStatementSchema.safeParse({ ...keyRotated, signatures: [MACHINE_SIGNATURE] }).success,
    ).toBe(false);
  });
});
