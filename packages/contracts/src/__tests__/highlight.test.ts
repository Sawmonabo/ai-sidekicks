// `highlight.read`'s boundary: a source is bounded by its encoded bytes, not its characters, and a
// span list is refused unless a surface can paint it: whole triples, known classes, non-empty
// spans in source order, and small enough for one reply frame.

import { describe, expect, it } from "vitest";

import {
  HIGHLIGHT_SOURCE_MAX_BYTES,
  HIGHLIGHT_SPANS_MAX_BYTES,
  HighlightReadRequestSchema,
  HighlightReadResponseSchema,
} from "../highlight.js";
import { jsonUtf8ByteLength } from "../jsonrpc.js";

describe("highlight.read request", () => {
  it("accepts a known language and its source", () => {
    expect(
      HighlightReadRequestSchema.safeParse({ language: "typescript", source: "const x = 1;" })
        .success,
    ).toBe(true);
  });

  it("refuses an empty source and one over the byte bound", () => {
    expect(HighlightReadRequestSchema.safeParse({ language: "json", source: "" }).success).toBe(
      false,
    );
    const atBound = "x".repeat(HIGHLIGHT_SOURCE_MAX_BYTES - 2);
    expect(jsonUtf8ByteLength(atBound)).toBe(HIGHLIGHT_SOURCE_MAX_BYTES);
    expect(
      HighlightReadRequestSchema.safeParse({ language: "json", source: atBound }).success,
    ).toBe(true);
    expect(
      HighlightReadRequestSchema.safeParse({ language: "json", source: `${atBound}x` }).success,
    ).toBe(false);
  });
});

describe("highlight.read reply", () => {
  it("accepts spans in source order", () => {
    expect(
      HighlightReadResponseSchema.safeParse({ spans: [0, 5, 0, 6, 3, 2, 12, 1, 4] }).success,
    ).toBe(true);
    expect(HighlightReadResponseSchema.safeParse({ spans: [] }).success).toBe(true);
  });

  it("refuses a span list a surface could not paint", () => {
    expect(HighlightReadResponseSchema.safeParse({ spans: [0, 5] }).success).toBe(false);
    expect(HighlightReadResponseSchema.safeParse({ spans: [0, 5, 5] }).success).toBe(false);
    expect(HighlightReadResponseSchema.safeParse({ spans: [0, 0, 1] }).success).toBe(false);
    expect(HighlightReadResponseSchema.safeParse({ spans: [0, 5, 0, 4, 2, 1] }).success).toBe(
      false,
    );
    expect(HighlightReadResponseSchema.safeParse({ spans: [10, 2, 0, 0, 2, 1] }).success).toBe(
      false,
    );
  });

  it("refuses a list too large for one reply frame", () => {
    const spanCount = Math.ceil(HIGHLIGHT_SPANS_MAX_BYTES / 10);
    const spans: number[] = [];
    for (let index = 0; index < spanCount; index += 1) {
      spans.push(1_000_000 + index * 2, 1, 0);
    }
    expect(jsonUtf8ByteLength(spans)).toBeGreaterThan(HIGHLIGHT_SPANS_MAX_BYTES);
    expect(HighlightReadResponseSchema.safeParse({ spans }).success).toBe(false);
  });
});
