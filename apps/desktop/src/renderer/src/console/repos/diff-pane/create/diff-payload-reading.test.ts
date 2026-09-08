// The four ways a served artifact read answers a surface after a change set.
//
// NONE OF THE FOUR IS A REFUSAL, which is what these cases are for: the daemon answered
// every one of them, and collapsing any pair would tell a reader the wrong thing about
// what to do next. The bound is the last of them and it REFUSES rather than truncating,
// which is the one claim here that a preview decode next door deliberately does not
// make.

import { describe, expect, it } from "vitest";

import { DIFF_PATCH_CHARACTER_CAP } from "../../../core/index.js";
import { artifactSummary } from "../../artifacts/artifacts.test-support.js";
import { diffPayloadReadingFrom } from "./diff-payload-reading.js";

const MANIFEST = artifactSummary({ artifactType: "diff" });

const PATCH_TEXT = `diff --git a/one.txt b/one.txt
--- a/one.txt
+++ b/one.txt
@@ -1,1 +1,1 @@
-before
+after
`;

/** The bytes as the wire carries them on the base64 arm. */
function asBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

describe("diffPayloadReadingFrom — the arm the reply itself declares", () => {
  it("reads an inline utf8 payload as the patch it is", () => {
    const reading = diffPayloadReadingFrom({
      manifest: MANIFEST,
      payload: PATCH_TEXT,
      payloadEncoding: "utf8",
    });
    expect(reading).toStrictEqual({ status: "patch", patchText: PATCH_TEXT });
  });

  it("decodes an inline base64 payload before deciding anything about it", () => {
    const reading = diffPayloadReadingFrom({
      manifest: MANIFEST,
      payload: asBase64(new TextEncoder().encode(PATCH_TEXT)),
      payloadEncoding: "base64",
    });
    expect(reading).toStrictEqual({ status: "patch", patchText: PATCH_TEXT });
  });

  it("reports a handle-only reply as deferred, which is a served answer and not a failure", () => {
    const reading = diffPayloadReadingFrom({ manifest: MANIFEST, payloadHandle: "sha256:abc" });
    expect(reading).toStrictEqual({ status: "deferred", payloadHandle: "sha256:abc" });
  });

  it("tells bytes that are not text apart from bytes that would not decode", () => {
    // Two different facts about the reply, leading a reader somewhere different: a
    // binary artifact served where a patch was expected, and a malformed transport
    // payload.
    const notText = diffPayloadReadingFrom({
      manifest: MANIFEST,
      payload: asBase64(new Uint8Array([0xff, 0xfe, 0xfd])),
      payloadEncoding: "base64",
    });
    expect(notText).toStrictEqual({ status: "opaque", encoding: "base64", reason: "not-utf8" });

    const undecodable = diffPayloadReadingFrom({
      manifest: MANIFEST,
      payload: "not base64 at all !!!",
      payloadEncoding: "base64",
    });
    expect(undecodable).toStrictEqual({
      status: "opaque",
      encoding: "base64",
      reason: "undecodable",
    });
  });

  it("negative control: a payload past the parser's bound is refused whole, never cut", () => {
    // A patch cut at a preview size would lose whole FILES a reader can reach, silently
    // — so the figure is reported and no partial change set is drawn.
    const oversized = "x".repeat(DIFF_PATCH_CHARACTER_CAP + 1);
    expect(
      diffPayloadReadingFrom({
        manifest: MANIFEST,
        payload: oversized,
        payloadEncoding: "utf8",
      }),
    ).toStrictEqual({ status: "over-cap", characterCount: DIFF_PATCH_CHARACTER_CAP + 1 });
  });

  it("takes a payload exactly at the bound, so the cap is a ceiling and not a fence", () => {
    const atCap = "x".repeat(DIFF_PATCH_CHARACTER_CAP);
    expect(
      diffPayloadReadingFrom({ manifest: MANIFEST, payload: atCap, payloadEncoding: "utf8" })
        .status,
    ).toBe("patch");
  });
});
