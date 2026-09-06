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
import { ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP } from "../../core/index.js";
import { artifactPayloadReadingFrom } from "./artifact-payload.js";

/** Those bytes as the wire carries them, built rather than transcribed. */
function base64Of(bytes: readonly number[]): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

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

  it("decodes only the prefix a bounded preview can draw", () => {
    // The defect: the whole inline payload was decoded — a full binary string, one
    // closure call per byte, a `Uint8Array` and a whole decoded string — and only then
    // sliced to two thousand characters. The arm is bounded by nothing on this side
    // and by nothing named on the wire, so a served log costs its whole length on the
    // renderer's one thread to draw a screenful and a half of it.
    //
    // ASSERTED BY WHAT THE DECODER NEVER REACHED. This payload is a long run of ASCII
    // followed by bytes that are not UTF-8 at all: a decode of the whole reply lands
    // `opaque`, and a decode of only what is drawn lands `text`. On the pre-fix code
    // the first assertion below reads "opaque".
    const drawable = "a".repeat(ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP * 8);
    const payload = base64Of(
      [...drawable].map((character) => character.charCodeAt(0)).concat([255, 255]),
    );

    const reading = artifactPayloadReadingFrom(ARTIFACT_ID, {
      manifest: MANIFEST,
      payload,
      payloadEncoding: "base64",
    });

    expect(reading.status).toBe("text");
    expect(reading.status === "text" ? reading.text.length : 0).toBe(
      ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP,
    );
    expect(reading.status === "text" ? reading.truncated : false).toBe(true);
  });

  it("keeps a multi-byte code point whole across the bound it decoded to", () => {
    // The bound is a BYTE prefix, so it can land inside a multi-byte sequence — and
    // the fatal decoder rejects one, which would report a payload that is perfectly
    // good text as bytes that are not text. Every code point here is four bytes and
    // the payload is twice the input bound, so the prefix ends one byte inside one.
    const astral = "\u{1F600}".repeat(ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP * 2);
    const payload = base64Of([...new TextEncoder().encode(astral)]);

    const reading = artifactPayloadReadingFrom(ARTIFACT_ID, {
      manifest: MANIFEST,
      payload,
      payloadEncoding: "base64",
    });

    expect(reading.status).toBe("text");
    expect(reading.status === "text" ? reading.text.startsWith("\u{1F600}") : false).toBe(true);
    expect(reading.status === "text" ? reading.text.includes("\uFFFD") : true).toBe(false);
  });

  it("cuts on a code-point boundary rather than through a surrogate pair", () => {
    // The cap counts UTF-16 CODE UNITS and an astral code point is two of them, so a
    // cut landing at an odd offset into a run of them used to end on a lone HIGH
    // surrogate — which the DOM paints as the replacement character, the one glyph
    // this module says a preview never draws. One ASCII character ahead of the run
    // puts the cut exactly one code unit inside a pair.
    const payload = `a${"\u{1F600}".repeat(ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP)}`;

    const reading = artifactPayloadReadingFrom(ARTIFACT_ID, {
      manifest: MANIFEST,
      payload,
      payloadEncoding: "utf8",
    });

    const text = reading.status === "text" ? reading.text : "";
    // The pair is dropped WHOLE: one code unit short of the cap, and the last unit
    // kept is not the opening half of anything.
    expect(text.length).toBe(ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP - 1);
    const lastCodeUnit = text.charCodeAt(text.length - 1);
    expect(lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff).toBe(false);
    expect(text).toBe(`a${"\u{1F600}".repeat((ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP - 2) / 2)}`);
    expect(reading.status === "text" ? reading.truncated : false).toBe(true);
  });

  it("negative control: a cut that lands on a boundary keeps the whole cap", () => {
    // Without this a preview that always backed off one unit would satisfy the case
    // above while shortening every truncated payload by a character it could draw.
    const reading = artifactPayloadReadingFrom(ARTIFACT_ID, {
      manifest: MANIFEST,
      payload: "\u{1F600}".repeat(ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP),
      payloadEncoding: "utf8",
    });

    expect(reading.status === "text" ? reading.text.length : 0).toBe(
      ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP,
    );
  });

  it("negative control: a payload inside the bound is still held to being text", () => {
    // Without this the two cases above would pass against a decode that had simply
    // stopped checking. A short reply that is not UTF-8 still says so.
    const reading = artifactPayloadReadingFrom(ARTIFACT_ID, {
      manifest: MANIFEST,
      payload: base64Of([0x61, 0xff, 0xff]),
      payloadEncoding: "base64",
    });
    expect(reading.status === "opaque" ? reading.reason : "").toBe("not-utf8");
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
