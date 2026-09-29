// The session verbs' wire shapes and the payloads of the events they append: each accepts the
// shape the console sends or the daemon answers, and refuses the bad cases the daemon must
// never act on or emit.
import { describe, expect, it } from "vitest";

import {
  SESSION_NAME_MAX_LEN,
  SESSION_SEARCH_QUERY_MAX_LEN,
  SessionFileSearchRequestSchema,
  SessionFileSearchResponseSchema,
  SessionLifecycleChangePayloadSchema,
  SessionMarkChangePayloadSchema,
  SessionRenamedPayloadSchema,
  SessionRenameRequestSchema,
  SessionSearchRequestSchema,
  SessionSearchResponseSchema,
  SessionShapeSchema,
  SessionTargetRequestSchema,
  SessionVerbResponseSchema,
} from "../session.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const USER_ID = "660e8400-e29b-41d4-a716-446655440001";

describe("SessionShapeSchema", () => {
  it("accepts the two shapes and refuses any other", () => {
    expect(SessionShapeSchema.safeParse("chat").success).toBe(true);
    expect(SessionShapeSchema.safeParse("project").success).toBe(true);
    expect(SessionShapeSchema.safeParse("terminal").success).toBe(false);
  });
});

describe("the bare session verbs (archive, reactivate, close, pin, unpin, mute, unmute, restart)", () => {
  it("take exactly the session", () => {
    expect(SessionTargetRequestSchema.safeParse({ sessionId: SESSION_ID }).success).toBe(true);
    expect(SessionTargetRequestSchema.safeParse({}).success).toBe(false);
    expect(
      SessionTargetRequestSchema.safeParse({ sessionId: SESSION_ID, pinOrder: 1 }).success,
    ).toBe(false);
  });

  it("answer an empty object and nothing else", () => {
    expect(SessionVerbResponseSchema.safeParse({}).success).toBe(true);
    expect(SessionVerbResponseSchema.safeParse({ sessionId: SESSION_ID }).success).toBe(false);
  });
});

describe("SessionRenameRequestSchema", () => {
  it("accepts a name, and `null` to return the session to untitled", () => {
    expect(
      SessionRenameRequestSchema.safeParse({ sessionId: SESSION_ID, name: "Nightly bump" }).success,
    ).toBe(true);
    expect(
      SessionRenameRequestSchema.safeParse({ sessionId: SESSION_ID, name: null }).success,
    ).toBe(true);
  });

  it("refuses an empty or blank name, which clearing spells as `null`", () => {
    expect(SessionRenameRequestSchema.safeParse({ sessionId: SESSION_ID, name: "" }).success).toBe(
      false,
    );
    expect(
      SessionRenameRequestSchema.safeParse({ sessionId: SESSION_ID, name: "  " }).success,
    ).toBe(false);
  });

  it("refuses a missing name and a name over the bound", () => {
    expect(SessionRenameRequestSchema.safeParse({ sessionId: SESSION_ID }).success).toBe(false);
    expect(
      SessionRenameRequestSchema.safeParse({
        sessionId: SESSION_ID,
        name: "n".repeat(SESSION_NAME_MAX_LEN + 1),
      }).success,
    ).toBe(false);
  });
});

describe("session.search", () => {
  const hit = {
    cursor: "cursor-7",
    line: "fix the login redirect",
    matchRanges: [{ start: 8, end: 13 }],
  };

  it("accepts a query, and refuses an empty or oversized one", () => {
    expect(SessionSearchRequestSchema.safeParse({ query: "login" }).success).toBe(true);
    expect(SessionSearchRequestSchema.safeParse({ query: "" }).success).toBe(false);
    expect(
      SessionSearchRequestSchema.safeParse({ query: "q".repeat(SESSION_SEARCH_QUERY_MAX_LEN + 1) })
        .success,
    ).toBe(false);
  });

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

  it("refuses a hit with nothing to mark and a group with no hits", () => {
    expect(
      SessionSearchResponseSchema.safeParse({
        groups: [{ sessionId: SESSION_ID, hits: [{ ...hit, matchRanges: [] }] }],
      }).success,
    ).toBe(false);
    expect(
      SessionSearchResponseSchema.safeParse({ groups: [{ sessionId: SESSION_ID, hits: [] }] })
        .success,
    ).toBe(false);
  });
});

describe("session.fileSearch", () => {
  it("accepts an empty query, which lists the working folder's files", () => {
    expect(
      SessionFileSearchRequestSchema.safeParse({ sessionId: SESSION_ID, query: "" }).success,
    ).toBe(true);
  });

  it("refuses a query with a NUL byte or over the bound", () => {
    expect(
      SessionFileSearchRequestSchema.safeParse({ sessionId: SESSION_ID, query: "src\0" }).success,
    ).toBe(false);
    expect(
      SessionFileSearchRequestSchema.safeParse({
        sessionId: SESSION_ID,
        query: "q".repeat(SESSION_SEARCH_QUERY_MAX_LEN + 1),
      }).success,
    ).toBe(false);
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

describe("the session verbs' event payloads", () => {
  it("a lifecycle move names the state it moved to, from the closed set", () => {
    expect(
      SessionLifecycleChangePayloadSchema.safeParse({
        sessionId: SESSION_ID,
        previousState: "active",
        newState: "archived",
        actor: USER_ID,
      }).success,
    ).toBe(true);
    expect(SessionLifecycleChangePayloadSchema.safeParse({ sessionId: SESSION_ID }).success).toBe(
      false,
    );
    expect(
      SessionLifecycleChangePayloadSchema.safeParse({ sessionId: SESSION_ID, newState: "deleted" })
        .success,
    ).toBe(false);
  });

  it("a rename names where it came from, and may clear the name", () => {
    expect(
      SessionRenamedPayloadSchema.safeParse({ sessionId: SESSION_ID, name: null, origin: "user" })
        .success,
    ).toBe(true);
    expect(
      SessionRenamedPayloadSchema.safeParse({
        sessionId: SESSION_ID,
        name: "Fix the login redirect",
        previousName: null,
        origin: "auto",
      }).success,
    ).toBe(true);
    expect(
      SessionRenamedPayloadSchema.safeParse({ sessionId: SESSION_ID, name: "x", origin: "system" })
        .success,
    ).toBe(false);
  });

  it("a pin or mute carries when it happened", () => {
    expect(
      SessionMarkChangePayloadSchema.safeParse({
        sessionId: SESSION_ID,
        at: "2026-09-24T02:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(SessionMarkChangePayloadSchema.safeParse({ sessionId: SESSION_ID }).success).toBe(false);
    expect(
      SessionMarkChangePayloadSchema.safeParse({ sessionId: SESSION_ID, at: "yesterday" }).success,
    ).toBe(false);
  });
});
