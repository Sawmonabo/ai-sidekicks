// The generated load-failure document. No `electron` mock: the module imports only
// `../services/renderer-scheme.ts`. What the handler does with it (the 200, content type, locked
// headers, exact-path match) is asserted in `../services/renderer-protocol.test.ts`.

import { describe, expect, it } from "vitest";

import {
  boundLoadFailureReason,
  buildLoadFailureUrl,
  LOAD_FAILURE_PATH,
  matchLoadFailureRequest,
  renderLoadFailureDocument,
} from "./load-failure-document.js";
import { RENDERER_ORIGIN } from "../services/renderer-scheme.js";

// One unpaired high surrogate: the only input on which `encodeURIComponent` throws `URIError`.
const LONE_HIGH_SURROGATE = "\uD800";
const LONE_LOW_SURROGATE = "\uDC00";
// A paired surrogate (U+1F6A8), the negative control for the bounding rule.
const ASTRAL_CODEPOINT = "\u{1F6A8}";

describe("boundLoadFailureReason", () => {
  it("passes an ordinary reason through unchanged", () => {
    expect(boundLoadFailureReason("ERR_FILE_NOT_FOUND (-6)")).toBe("ERR_FILE_NOT_FOUND (-6)");
  });

  // Bounded because an error message is unbounded and a longer document would cost memory.
  it("bounds a very long reason", () => {
    expect(boundLoadFailureReason("x".repeat(5000))).toBe("x".repeat(300));
  });

  // By code point, not code unit: `slice(0, 300)` on astral characters can cut a pair in half
  // and yield a lone surrogate, which `encodeURIComponent` throws on.
  it("cuts at a code-point boundary rather than a code-unit one", () => {
    const bounded = boundLoadFailureReason(ASTRAL_CODEPOINT.repeat(400));

    expect(Array.from(bounded)).toHaveLength(300);
    expect(bounded).toBe(ASTRAL_CODEPOINT.repeat(300));
    // No half-pair survived.
    expect(/[\uD800-\uDFFF]/u.test(bounded)).toBe(false);
  });

  it.each([
    ["a lone high surrogate", LONE_HIGH_SURROGATE],
    ["a lone low surrogate", LONE_LOW_SURROGATE],
  ])("replaces %s that arrived in the reason itself", (_label, surrogate) => {
    const bounded = boundLoadFailureReason(`before${surrogate}after`);

    expect(bounded).toBe("before�after");
  });

  it("leaves a well-formed surrogate pair intact", () => {
    expect(boundLoadFailureReason(`before${ASTRAL_CODEPOINT}after`)).toBe(
      `before${ASTRAL_CODEPOINT}after`,
    );
  });
});

describe("buildLoadFailureUrl", () => {
  it("addresses the reserved path on the renderer origin", () => {
    const url = buildLoadFailureUrl("boom");

    expect(url.startsWith(`${RENDERER_ORIGIN}${LOAD_FAILURE_PATH}?`)).toBe(true);
    expect(matchLoadFailureRequest(url)).toBe("boom");
  });

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

describe("matchLoadFailureRequest", () => {
  it("reads the reason back off the reserved path", () => {
    expect(matchLoadFailureRequest(buildLoadFailureUrl("ERR_FAILED (-2)"))).toBe("ERR_FAILED (-2)");
  });

  it("matches the reserved path with no reason at all", () => {
    expect(matchLoadFailureRequest(`${RENDERER_ORIGIN}${LOAD_FAILURE_PATH}`)).toBe("");
  });

  // Exact-path matching, never a prefix: anything else falls through to the resolver.
  it.each([
    ["a path that merely starts with the reserved one", `${LOAD_FAILURE_PATH}/../index.html`],
    ["a longer path under it", `${LOAD_FAILURE_PATH}/extra`],
    ["an unrelated path", "/index.html"],
  ])("does not match %s", (_label, requestPath) => {
    expect(matchLoadFailureRequest(`${RENDERER_ORIGIN}${requestPath}`)).toBeNull();
  });

  it("does not match on another host", () => {
    expect(
      matchLoadFailureRequest(`sidekicks-renderer://evil${LOAD_FAILURE_PATH}?reason=x`),
    ).toBeNull();
  });

  it("does not match on another scheme", () => {
    expect(matchLoadFailureRequest(`https://app${LOAD_FAILURE_PATH}?reason=x`)).toBeNull();
  });
});

describe("renderLoadFailureDocument", () => {
  it("carries the reason", () => {
    expect(renderLoadFailureDocument("ERR_FILE_NOT_FOUND (-6)")).toContain(
      "ERR_FILE_NOT_FOUND (-6)",
    );
  });

  // The reason comes from an error message that remote input can shape, so it must arrive as
  // text even when it is markup.
  it("escapes a reason that is markup", () => {
    const document = renderLoadFailureDocument('</code><script>alert("x")</script>');

    expect(document).not.toContain("<script>");
    expect(document).toContain("&lt;script&gt;");
  });

  it("says so when there is no reason at all", () => {
    expect(renderLoadFailureDocument("")).toContain("No reason was reported.");
  });

  it("bounds a very long reason", () => {
    const document = renderLoadFailureDocument("x".repeat(5000));

    expect(document).not.toContain("x".repeat(400));
    expect(document).toContain("x".repeat(300));
  });
});
