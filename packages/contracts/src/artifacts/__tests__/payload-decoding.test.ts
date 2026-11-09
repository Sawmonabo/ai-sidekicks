// A payload's bytes are read as text only when they are UTF-8; a lenient read would draw
// replacement characters as the artifact's content.
import { describe, expect, it } from "vitest";

import { decodeArtifactPayloadText } from "../payload-decoding.js";

describe("decodeArtifactPayloadText", () => {
  it("reads UTF-8 bytes as their text", () => {
    expect(decodeArtifactPayloadText(new TextEncoder().encode("héllo"))).toStrictEqual({
      status: "text",
      text: "héllo",
    });
  });

  it("names bytes that are not UTF-8 rather than drawing replacement characters", () => {
    expect(decodeArtifactPayloadText(new Uint8Array([0xff]))).toStrictEqual({
      status: "opaque",
      reason: "not-utf8",
    });
  });
});
