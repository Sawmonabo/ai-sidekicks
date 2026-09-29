// The markdown policy, as values — and the one thing it must never do is fail open.

import { describe, expect, it } from "vitest";

import {
  DEFERRED_FENCE_LANGUAGES,
  INCOMPLETE_LINK_SENTINEL,
  isDeferredFenceLanguage,
} from "./markdown-rules.js";

describe("deferred fences", () => {
  it("defers math and diagrams and nothing else", () => {
    expect(isDeferredFenceLanguage("math")).toBe(true);
    expect(isDeferredFenceLanguage("latex")).toBe(true);
    expect(isDeferredFenceLanguage("tex")).toBe(true);
    expect(isDeferredFenceLanguage("mermaid")).toBe(true);
    expect(isDeferredFenceLanguage("typescript")).toBe(false);
    expect(isDeferredFenceLanguage("bash")).toBe(false);
  });

  it("is total over the enumeration it is derived from", () => {
    // The two are one closed set and a predicate over it, so every declared member
    // must answer `true`. Enumerating four literals above tests the four somebody
    // thought of; this tests the set, and a fifth member added without a matching
    // arm fails here rather than rendering as an ordinary code block.
    const undeferred = DEFERRED_FENCE_LANGUAGES.filter(
      (language) => !isDeferredFenceLanguage(language),
    );
    expect(undeferred).toStrictEqual([]);
    expect(DEFERRED_FENCE_LANGUAGES.length).toBeGreaterThan(0);
  });

  it("reads an info string the way commonmark does — first word, case-insensitive", () => {
    expect(isDeferredFenceLanguage("  MATH  ")).toBe(true);
    expect(isDeferredFenceLanguage("mermaid theme=dark")).toBe(true);
  });

  it("negative control: an absent info string defers nothing", () => {
    // A fence with no language must take the ordinary code path; deferring it would
    // hold back every unlabeled block in the log until it settled.
    expect(isDeferredFenceLanguage(null)).toBe(false);
    expect(isDeferredFenceLanguage(undefined)).toBe(false);
    expect(isDeferredFenceLanguage("")).toBe(false);
  });
});

describe("the incomplete-link sentinel", () => {
  it("is the library's own spelling, so both sides of the seam agree", () => {
    expect(INCOMPLETE_LINK_SENTINEL).toBe("streamdown:incomplete-link");
  });
});
