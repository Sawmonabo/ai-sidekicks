// The two session searches: a hit's match range ends after it starts, and a file search cannot
// match more files than it searched.
import { describe, expect, it } from "vitest";

import {
  SessionFileSearchRequestSchema,
  SessionFileSearchResponseSchema,
  SessionSearchResponseSchema,
} from "../session.js";

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
    });
    expect(result.success).toBe(true);
  });

  it("refuses a match range that does not end after it starts", () => {
    const result = SessionSearchResponseSchema.safeParse({
      groups: [{ sessionId: SESSION_ID, hits: [{ ...hit, matchRanges: [{ start: 8, end: 8 }] }] }],
    });
    expect(result.success).toBe(false);
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
