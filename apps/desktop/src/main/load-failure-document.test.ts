// Plan-023 Phase 1B (T-023p-1B-1) — the generated load-failure document.
//
// A rejected `loadURL` used to leave a live blank window; the window now loads
// this instead. It is generated in the main process rather than emitted into the
// bundle, because the failure it reports is "the bundle could not be loaded" —
// a fallback living in the tree that just failed is missing exactly when it is
// needed.
//
// No `electron` mock: the module under test imports only `./renderer-scheme.ts`.
// What the HANDLER does with this document — the 200, the content type, the
// locked headers, the exact-path match — is asserted in `./protocol.test.ts`.

import { describe, expect, it } from "vitest";

import {
  boundLoadFailureReason,
  buildLoadFailureUrl,
  LOAD_FAILURE_PATH,
  matchLoadFailureRequest,
  renderLoadFailureDocument,
} from "./load-failure-document.js";
import { RENDERER_ORIGIN } from "./renderer-scheme.js";

// One unpaired high surrogate. `encodeURIComponent` throws `URIError` on exactly
// this input and on nothing else, so it is the whole hazard class in one string.
const LONE_HIGH_SURROGATE = "\uD800";
const LONE_LOW_SURROGATE = "\uDC00";
// A paired surrogate — the negative control for the bounding rule below. This
// is a legitimate astral codepoint (U+1F6A8) and must survive untouched.
const ASTRAL_CODEPOINT = "\u{1F6A8}";

describe("boundLoadFailureReason", () => {
  it("passes an ordinary reason through unchanged", () => {
    expect(boundLoadFailureReason("ERR_FILE_NOT_FOUND (-6)")).toBe("ERR_FILE_NOT_FOUND (-6)");
  });

  // Bounded, because an error message is neither bounded nor authored by us and
  // a document that grew with it would be a memory cost driven by the failure.
  it("bounds a very long reason", () => {
    expect(boundLoadFailureReason("x".repeat(5000))).toBe("x".repeat(300));
  });

  // By CODE POINT, not by UTF-16 code unit. `slice(0, 300)` on a string of
  // astral characters cuts a surrogate pair in half at the boundary and yields
  // a lone surrogate, which is the one input `encodeURIComponent` throws on —
  // so the bound and the surrogate rule are the same defect seen twice.
  it("cuts at a code-point boundary rather than a code-unit one", () => {
    const bounded = boundLoadFailureReason(ASTRAL_CODEPOINT.repeat(400));

    expect(Array.from(bounded)).toHaveLength(300);
    expect(bounded).toBe(ASTRAL_CODEPOINT.repeat(300));
    // The negative control the bound exists for: no half-pair survived.
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

  // The whole reason the bound runs BEFORE the encode. Without it this throws
  // `URIError` — inside a `.catch` handler, where a throw becomes an unhandled
  // rejection and the window stays live and blank.
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

  // Exact-path matching, never a prefix: anything else under the reserved path
  // falls through to the ordinary resolver, which refuses it.
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

  // The reason is assembled from an error message, one of the few strings in
  // this process a remote input can shape. It must arrive as text even when it
  // is markup — and the document carries no script for it to become part of.
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
