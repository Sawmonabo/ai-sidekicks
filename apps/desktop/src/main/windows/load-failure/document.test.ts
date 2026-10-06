// The generated load-failure document. No `electron` mock: the module imports only
// `../services/renderer/scheme.ts`. What the handler does with it (the 200, content type, locked
// headers, host match) is asserted in `../services/renderer/protocol.test.ts`.

import { describe, expect, it } from "vitest";

import {
  buildLoadFailureUrl,
  matchLoadFailureRequest,
  renderLoadFailureDocument,
} from "./document.js";

// One unpaired high surrogate: the only input on which `encodeURIComponent` throws `URIError`.
const LONE_HIGH_SURROGATE = "\uD800";
// A paired surrogate (U+1F6A8), two code units per character.
const ASTRAL_CODEPOINT = "\u{1F6A8}";

describe("buildLoadFailureUrl", () => {
  // The bound runs before the encode; otherwise this throws `URIError` inside a `.catch`
  // handler, leaving the window blank.
  it("does not throw on a reason carrying a lone surrogate", () => {
    const url = buildLoadFailureUrl(`ERR${LONE_HIGH_SURROGATE}FAIL`);

    expect(matchLoadFailureRequest(url)).toBe("ERR�FAIL");
  });

  it("does not throw on a reason that is 5000 astral characters", () => {
    expect(() => buildLoadFailureUrl(ASTRAL_CODEPOINT.repeat(5000))).not.toThrow();
  });
});

describe("renderLoadFailureDocument", () => {
  // The reason comes from an error message that remote input can shape, so it must arrive as
  // text even when it is markup.
  it("escapes a reason that is markup", () => {
    const document = renderLoadFailureDocument('</code><script>alert("x")</script>');

    expect(document).not.toContain("<script>");
    expect(document).toContain("&lt;script&gt;");
  });

  // Bounded because an error message is unbounded and a longer document would cost memory.
  it("bounds a very long reason", () => {
    const document = renderLoadFailureDocument("x".repeat(5000));

    expect(document).not.toContain("x".repeat(400));
    expect(document).toContain("x".repeat(300));
  });
});
