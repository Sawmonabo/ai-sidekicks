// A machine's registration is the control plane's admission record for its key,
// and its DNS challenge request is the one way a machine gets the relay to write a
// DNS record, so both refuse anything but their own shape.
import { describe, expect, it } from "vitest";

import {
  RuntimeNodeCertificateChallengeSetRequestSchema,
  RuntimeNodeRegisterRequestSchema,
  RuntimeNodeRenameRequestSchema,
} from "../runtime-node.js";

const bytes = (length: number): string => Buffer.alloc(length, 3).toString("base64");

const registration = {
  nodeId: "mac-mini",
  identityKey: { algorithm: "ed25519", publicKey: bytes(32) },
  name: "Mac mini",
  platform: "macOS 15.6",
  serviceVersion: "0.1.0",
};

const renamed = {
  kind: "runtimenode.renamed",
  previousHash: "b".repeat(64),
  issuedAt: "2026-09-12T10:00:00.000Z",
  signatures: [{ signer: "runtimenode", nodeId: "mac-mini", signature: bytes(64) }],
  nodeId: "mac-mini",
  name: "Studio Mac",
};

describe("runtimenode.register", () => {
  it("accepts the machine's id, key, name, platform and service version", () => {
    expect(RuntimeNodeRegisterRequestSchema.safeParse(registration).success).toBe(true);
  });

  it("refuses a registration without its service version", () => {
    const { serviceVersion: _omitted, ...withoutVersion } = registration;
    expect(RuntimeNodeRegisterRequestSchema.safeParse(withoutVersion).success).toBe(false);
  });

  it("refuses a machine key that is not Ed25519", () => {
    expect(
      RuntimeNodeRegisterRequestSchema.safeParse({
        ...registration,
        identityKey: { algorithm: "p256", publicKey: bytes(65) },
      }).success,
    ).toBe(false);
  });
});

describe("runtimenode.rename", () => {
  it("renames with a runtimenode.renamed statement and nothing else", () => {
    expect(RuntimeNodeRenameRequestSchema.safeParse({ statement: renamed }).success).toBe(true);
    expect(
      RuntimeNodeRenameRequestSchema.safeParse({
        statement: { ...renamed, kind: "runtimenode.removed" },
      }).success,
    ).toBe(false);
  });
});

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

  it("refuses a value that is not a SHA-256 digest in base64url", () => {
    expect(
      RuntimeNodeCertificateChallengeSetRequestSchema.safeParse({
        name: "_acme-challenge.mac-mini.relay.example.com",
        value: "short",
      }).success,
    ).toBe(false);
  });
});
