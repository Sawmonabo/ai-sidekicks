// An artifact read replies in one of two shapes: a handle to fetch the payload with,
// or the payload with the encoding it is written in. Each refusal below hands the
// reply schema a shape that is neither. The last schema case checks that the two real
// shapes still parse, so the refusals cannot pass against a schema that refuses
// everything. The ingest chunk's cases hold it to the frame ceiling it rides under,
// and the decoder's cases hold it to reading a payload by its encoding alone.
import { describe, expect, it } from "vitest";

import { ArtifactReadResponseSchema, decodeArtifactPayloadText } from "../artifacts/index.js";
import { ATTACHMENT_INGEST_CHUNK_MAX_BYTES } from "../artifacts/ingest.js";
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

/** Base64 characters an RFC 4648 section 4 encoder emits for this many raw bytes. */
function base64Length(decodedByteLength: number): number {
  return Math.ceil(decodedByteLength / 3) * 4;
}

describe("ATTACHMENT_INGEST_CHUNK_MAX_BYTES", () => {
  it("keeps an encoded chunk inside the frame ceiling the wire declares", () => {
    // The chunk size is fixed rather than tunable because THIS is what fixes it: the wire
    // is JSON with no binary serialization, so a chunk rides as base64 and expands by 4/3,
    // and the framer refuses a declared length over `MAX_MESSAGE_BYTES` before it buffers
    // a body.
    expect(base64Length(ATTACHMENT_INGEST_CHUNK_MAX_BYTES)).toBeLessThan(MAX_MESSAGE_BYTES);
  });

  it("negative control: the expansion is what the ceiling binds, not the raw length", () => {
    // A raw chunk just under the ceiling fits by the wrong measure and overflows by the
    // right one, which is the whole reason the cap is not simply the ceiling.
    const rawChunkAtTheCeiling = MAX_MESSAGE_BYTES - 1;
    expect(rawChunkAtTheCeiling).toBeLessThan(MAX_MESSAGE_BYTES);
    expect(base64Length(rawChunkAtTheCeiling)).toBeGreaterThan(MAX_MESSAGE_BYTES);
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
