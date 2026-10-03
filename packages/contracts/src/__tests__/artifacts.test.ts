// An artifact read replies with a handle to fetch the payload with, or the payload with the
// encoding it is written in, and nothing a reader could not act on.
import { describe, expect, it } from "vitest";

import {
  ArtifactReadRequestSchema,
  ArtifactReadResponseSchema,
  decodeArtifactPayloadText,
} from "../artifacts/operations.js";
import { ARTIFACT_CHUNK_MAX_BYTES } from "../artifacts/ingest.js";
import { MAX_MESSAGE_BYTES } from "../jsonrpc.js";

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
const VERSION = { versionNumber: 3, versionCount: 3, versionWrittenAt: "2026-01-01T14:20:00.000Z" };

describe("ArtifactReadResponseSchema", () => {
  it("accepts the handle reply and the inline reply, with or without the handle", () => {
    const deferred = { manifest: MANIFEST, ...VERSION, payloadHandle: PAYLOAD_HANDLE };
    const inline = {
      manifest: MANIFEST,
      ...VERSION,
      payload: "aGVsbG8gd29ybGQ=",
      payloadEncoding: "utf8",
    };
    const inlineWithHandle = { ...inline, payloadHandle: PAYLOAD_HANDLE };
    expect(ArtifactReadResponseSchema.safeParse(deferred).success).toBe(true);
    expect(ArtifactReadResponseSchema.safeParse(inline).success).toBe(true);
    expect(ArtifactReadResponseSchema.safeParse(inlineWithHandle).success).toBe(true);
  });

  // Each of these leaves a reader with no way to reach or decode the payload.
  it.each([
    ["neither a handle nor a payload", {}],
    ["a payload with no encoding", { payload: "aGVsbG8=" }],
    ["an encoding with no payload", { payloadHandle: PAYLOAD_HANDLE, payloadEncoding: "utf8" }],
    ["an encoding other than utf8 or base64", { payload: "aGVsbG8=", payloadEncoding: "hex" }],
  ])("refuses a reply with %s", (_label, payloadMembers) => {
    const reply = { manifest: MANIFEST, ...VERSION, ...payloadMembers };
    expect(ArtifactReadResponseSchema.safeParse(reply).success).toBe(false);
  });

  it("refuses a version in view past how many versions exist", () => {
    const reply = {
      manifest: MANIFEST,
      ...VERSION,
      versionNumber: 4,
      payloadHandle: PAYLOAD_HANDLE,
    };
    expect(ArtifactReadResponseSchema.safeParse(reply).success).toBe(false);
  });
});

describe("ArtifactReadRequestSchema", () => {
  it("refuses a window on a read that declines the payload", () => {
    const range = { offset: 0, length: 1 };
    expect(
      ArtifactReadRequestSchema.safeParse({ artifactId: MANIFEST.id, includePayload: true, range })
        .success,
    ).toBe(true);
    expect(
      ArtifactReadRequestSchema.safeParse({ artifactId: MANIFEST.id, includePayload: false, range })
        .success,
    ).toBe(false);
  });
});

/** Base64 characters an RFC 4648 section 4 encoder emits for this many raw bytes. */
function base64Length(decodedByteLength: number): number {
  return Math.ceil(decodedByteLength / 3) * 4;
}

describe("ARTIFACT_CHUNK_MAX_BYTES", () => {
  it("keeps an encoded chunk inside the frame ceiling the wire declares", () => {
    // The wire is JSON with no binary form, so a chunk rides as base64 and expands by 4/3;
    // the framer refuses a declared length over `MAX_MESSAGE_BYTES` before it buffers a body.
    expect(base64Length(ARTIFACT_CHUNK_MAX_BYTES)).toBeLessThan(MAX_MESSAGE_BYTES);
  });
});

describe("decodeArtifactPayloadText", () => {
  it("reads a utf8 payload as the text it is, even when it looks like base64", () => {
    expect(decodeArtifactPayloadText("aGVsbG8=", "utf8")).toStrictEqual({
      status: "text",
      text: "aGVsbG8=",
    });
  });

  it("decodes a base64 payload and reads its bytes as UTF-8", () => {
    expect(decodeArtifactPayloadText("aMOpbGxv", "base64")).toStrictEqual({
      status: "text",
      text: "h\u00e9llo",
    });
  });

  it("names bytes that are not UTF-8 rather than drawing replacement characters", () => {
    expect(decodeArtifactPayloadText("/w==", "base64")).toStrictEqual({
      status: "opaque",
      reason: "not-utf8",
    });
  });

  it("names a base64 payload that does not decode", () => {
    expect(decodeArtifactPayloadText("not base64!", "base64")).toStrictEqual({
      status: "opaque",
      reason: "undecodable",
    });
  });
});
