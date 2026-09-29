// `highlight.read`'s boundary: the request a surface sends and the packed span
// list it paints from.

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

  it("refuses a language outside the closed set", () => {
    expect(
      HighlightReadRequestSchema.safeParse({ language: "brainfuck", source: "+++" }).success,
    ).toBe(false);
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

  it("refuses a member it does not declare", () => {
    expect(
      HighlightReadRequestSchema.safeParse({ language: "go", source: "package main", theme: "x" })
        .success,
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

  it("refuses a list that is not whole triples", () => {
    expect(HighlightReadResponseSchema.safeParse({ spans: [0, 5] }).success).toBe(false);
  });

  it("refuses a class index outside the span classes", () => {
    expect(HighlightReadResponseSchema.safeParse({ spans: [0, 5, 5] }).success).toBe(false);
  });

  it("refuses an empty span", () => {
    expect(HighlightReadResponseSchema.safeParse({ spans: [0, 0, 1] }).success).toBe(false);
  });

  it("refuses spans that overlap or run backwards", () => {
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
