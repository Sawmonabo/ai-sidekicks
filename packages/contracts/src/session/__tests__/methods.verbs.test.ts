// The two session searches: a hit's match ranges each end after they start, run in order, never
// overlap and sit inside the hit's line, and a file search cannot match more files than it
// searched.
import { describe, expect, it } from "vitest";

import {
  SessionFileSearchRequestSchema,
  SessionFileSearchResponseSchema,
  SessionSearchResponseSchema,
} from "../methods.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

describe("session.search", () => {
  const hit = {
    cursor: "cursor-7",
    line: "fix the login redirect",
    matchRanges: [{ start: 8, end: 13 }],
  };

  it("accepts hits grouped by session, an untitled session's group without a name", () => {
    const result = SessionSearchResponseSchema.safeParse({
      groups: [
        { sessionId: SESSION_ID, name: "Login work", hits: [hit] },
        { sessionId: SESSION_ID, hits: [hit] },
      ],
      hasMore: false,
    });
    expect(result.success).toBe(true);
  });

  it("refuses a match range that does not end after it starts", () => {
    const result = SessionSearchResponseSchema.safeParse({
      groups: [{ sessionId: SESSION_ID, hits: [{ ...hit, matchRanges: [{ start: 8, end: 8 }] }] }],
      hasMore: false,
    });
    expect(result.success).toBe(false);
  });

  it("refuses match ranges out of order, overlapping, or ending past the line", () => {
    const withRanges = (matchRanges: { start: number; end: number }[]) => ({
      groups: [{ sessionId: SESSION_ID, hits: [{ ...hit, matchRanges }] }],
      hasMore: false,
    });
    // The line is 22 UTF-16 code units long.
    expect(
      SessionSearchResponseSchema.safeParse(withRanges([{ start: 17, end: 23 }])).success,
    ).toBe(false);
    expect(
      SessionSearchResponseSchema.safeParse(
        withRanges([
          { start: 8, end: 13 },
          { start: 10, end: 14 },
        ]),
      ).success,
    ).toBe(false);
    expect(
      SessionSearchResponseSchema.safeParse(
        withRanges([
          { start: 14, end: 22 },
          { start: 8, end: 13 },
        ]),
      ).success,
    ).toBe(false);
    expect(
      SessionSearchResponseSchema.safeParse(
        withRanges([
          { start: 8, end: 13 },
          { start: 14, end: 22 },
        ]),
      ).success,
    ).toBe(true);
  });
});

describe("session.fileSearch", () => {
  it("accepts an empty query, which lists the working folder's files", () => {
    expect(
      SessionFileSearchRequestSchema.safeParse({ sessionId: SESSION_ID, query: "" }).success,
    ).toBe(true);
  });

  it("tells a folder with no files from a query that matched nothing", () => {
    expect(
      SessionFileSearchResponseSchema.parse({ paths: [], searchedFileCount: 0 }),
    ).toStrictEqual({
      paths: [],
      searchedFileCount: 0,
    });
    expect(
      SessionFileSearchResponseSchema.safeParse({ paths: [], searchedFileCount: 12 }).success,
    ).toBe(true);
  });

  it("refuses more matches than files searched", () => {
    expect(
      SessionFileSearchResponseSchema.safeParse({ paths: ["a.ts", "b.ts"], searchedFileCount: 1 })
        .success,
    ).toBe(false);
  });
});
