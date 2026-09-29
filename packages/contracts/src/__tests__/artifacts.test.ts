// An artifact read replies in one of two shapes: a handle to fetch the payload with,
// or the payload with the encoding it is written in. Each refusal below hands the
// reply schema a shape that is neither. The last case checks that the two real
// shapes still parse, so the refusals cannot pass against a schema that refuses
// everything.
import { describe, expect, it } from "vitest";

import { ArtifactReadResponseSchema } from "../artifacts/index.js";

const MANIFEST = {
  id: "0f2b4d5e-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  sessionId: "550e8400-e29b-41d4-a716-446655440000",
  artifactType: "file",
  digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  size: 11,
  annotations: { "org.opencontainers.image.title": "notes.txt" },
  state: "published",
  metadata: { mediaType: "text/plain" },
  createdAt: "2026-01-01T14:20:00.000Z",
};
const PAYLOAD_HANDLE = "cas/sha256-0000";

describe("ArtifactReadResponseSchema", () => {
  it("refuses a bare manifest in place of the reply", () => {
    expect(ArtifactReadResponseSchema.safeParse(MANIFEST).success).toBe(false);
  });

  it("refuses a reply with neither a handle nor a payload", () => {
    expect(ArtifactReadResponseSchema.safeParse({ manifest: MANIFEST }).success).toBe(false);
  });

  it("refuses a payload with no encoding, which leaves no way to decode it", () => {
    const reply = { manifest: MANIFEST, payload: "aGVsbG8=" };
    expect(ArtifactReadResponseSchema.safeParse(reply).success).toBe(false);
  });

  it("refuses an encoding with no payload, which describes bytes that are not there", () => {
    const reply = { manifest: MANIFEST, payloadHandle: PAYLOAD_HANDLE, payloadEncoding: "base64" };
    expect(ArtifactReadResponseSchema.safeParse(reply).success).toBe(false);
  });

  it("refuses an encoding other than utf8 or base64", () => {
    const reply = { manifest: MANIFEST, payload: "aGVsbG8=", payloadEncoding: "utf16" };
    expect(ArtifactReadResponseSchema.safeParse(reply).success).toBe(false);
  });

  it("accepts the handle reply and the inline reply, with or without the handle", () => {
    const deferred = { manifest: MANIFEST, payloadHandle: PAYLOAD_HANDLE };
    const inline = { manifest: MANIFEST, payload: "aGVsbG8gd29ybGQ=", payloadEncoding: "utf8" };
    const inlineWithHandle = { ...inline, payloadHandle: PAYLOAD_HANDLE };
    expect(ArtifactReadResponseSchema.safeParse(deferred).success).toBe(true);
    expect(ArtifactReadResponseSchema.safeParse(inline).success).toBe(true);
    expect(ArtifactReadResponseSchema.safeParse(inlineWithHandle).success).toBe(true);
  });
});
