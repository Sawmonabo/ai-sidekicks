// One served payload reply read as the arm the pane draws, with no bridge and no pane.
//
// The decode is the whole subject: the reply's own `payloadEncoding` decides which arm
// a served answer lands on, and each case here is a claim the pane would otherwise
// make falsely — that a handle is bytes, that undecodable base64 is a refusal, or that
// bytes which are not text can be previewed as though they were.
//
// Moved here whole when `artifact-pane-reading.ts` split: the reductions stayed with
// the reading and the decode came with its module. Every case is the one it was.

import { describe, expect, it } from "vitest";

import type { GrowthArtifactRead } from "../../bridge/index.js";
import { ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP } from "./artifact-bounds.js";
import { artifactPayloadReadingFrom } from "./artifact-payload.js";

describe("artifact payload reading — the served union has two arms and each splits", () => {
  const ARTIFACT_ID = "019b7b30-0280-7c11-8420-b1a5c0de2201";
  const MANIFEST = {
    artifactId: ARTIFACT_ID,
    sessionId: "session-1",
    artifactType: "diff",
    digest: "sha256:2b4c",
    size: 22,
    annotations: {},
    visibility: "shared",
    state: "published",
    metadata: {},
    createdAt: "2026-09-02T07:00:00.000Z",
  } as unknown as GrowthArtifactRead["manifest"];

  it("reads a handle-only reply as the deferred arm, carrying the handle", () => {
    expect(
      artifactPayloadReadingFrom(ARTIFACT_ID, {
        manifest: MANIFEST,
        payloadHandle: "sha256:2b4c",
      }),
    ).toStrictEqual({ status: "deferred", artifactId: ARTIFACT_ID, payloadHandle: "sha256:2b4c" });
  });

  it("decodes base64 bytes by the encoding the reply declared, never by sniffing", () => {
    const reading = artifactPayloadReadingFrom(ARTIFACT_ID, {
      manifest: MANIFEST,
      payload: "ZGlmZiAtLWdpdCBhL29uZSBiL29uZQ==",
      payloadEncoding: "base64",
    });
    expect(reading).toStrictEqual({
      status: "text",
      artifactId: ARTIFACT_ID,
      encoding: "base64",
      text: "diff --git a/one b/one",
      truncated: false,
    });
  });

  it("takes a utf8 payload as it stands", () => {
    const reading = artifactPayloadReadingFrom(ARTIFACT_ID, {
      manifest: MANIFEST,
      payload: "already text",
      payloadEncoding: "utf8",
    });
    expect(reading.status === "text" ? reading.text : "").toBe("already text");
  });

  it("bounds the preview and says it did", () => {
    const reading = artifactPayloadReadingFrom(ARTIFACT_ID, {
      manifest: MANIFEST,
      payload: "x".repeat(ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP + 1),
      payloadEncoding: "utf8",
    });
    expect(reading.status === "text" ? reading.text.length : 0).toBe(
      ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP,
    );
    expect(reading.status === "text" ? reading.truncated : false).toBe(true);
  });

  it("names bytes that are not text rather than decoding them into question marks", () => {
    // `0xFF 0xFF` is not valid UTF-8. A lenient decoder answers with replacement
    // characters, which a preview would draw as though they were the payload.
    expect(
      artifactPayloadReadingFrom(ARTIFACT_ID, {
        manifest: MANIFEST,
        payload: "//8=",
        payloadEncoding: "base64",
      }),
    ).toStrictEqual({
      status: "opaque",
      artifactId: ARTIFACT_ID,
      encoding: "base64",
      reason: "not-utf8",
    });
  });

  it("names an undecodable base64 payload as its own reason", () => {
    const reading = artifactPayloadReadingFrom(ARTIFACT_ID, {
      manifest: MANIFEST,
      payload: "not base64 at all!!",
      payloadEncoding: "base64",
    });
    expect(reading.status === "opaque" ? reading.reason : "").toBe("undecodable");
  });

  it("negative control: nothing about the arm is inferred from the bytes", () => {
    // The same bytes on the two encodings are two different readings, which is what
    // makes `payloadEncoding` load-bearing rather than a hint.
    const asBase64 = artifactPayloadReadingFrom(ARTIFACT_ID, {
      manifest: MANIFEST,
      payload: "ZGlmZg==",
      payloadEncoding: "base64",
    });
    const asUtf8 = artifactPayloadReadingFrom(ARTIFACT_ID, {
      manifest: MANIFEST,
      payload: "ZGlmZg==",
      payloadEncoding: "utf8",
    });
    expect(asBase64.status === "text" ? asBase64.text : "").toBe("diff");
    expect(asUtf8.status === "text" ? asUtf8.text : "").toBe("ZGlmZg==");
  });
});
