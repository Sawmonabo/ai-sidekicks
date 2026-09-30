// Held review notes: each request accepts the shape Review sends, and refuses the
// cases the design names.
import { describe, expect, it } from "vitest";

import {
  ReviewNoteAddRequestSchema,
  ReviewNoteRemoveRequestSchema,
  ReviewNoteSetSchema,
} from "../review-note.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const NOTE_ID = "7d444840-9dc0-41bb-a1a4-4b3a9c1c3d2e";
const COMMITTED = {
  scope: "branch",
  base: "main",
  headCommitId: "9fceb02d0ae598e95dc970b74767f19372d61af8",
};

const note = {
  sessionId: SESSION_ID,
  noteId: NOTE_ID,
  comparison: COMMITTED,
  path: "src/login.ts",
  side: "added",
  line: 42,
  body: "This retry never backs off.",
};

describe("session.reviewNoteAdd", () => {
  it("accepts a note on committed lines and a note on uncommitted lines", () => {
    const uncommitted = {
      scope: "changes",
      base: "main",
      workingTreeBlobId: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
    };
    for (const comparison of [COMMITTED, uncommitted]) {
      expect(ReviewNoteAddRequestSchema.safeParse({ ...note, comparison }).success).toBe(true);
    }
  });

  it("refuses a comparison that names both a commit and the working tree", () => {
    const comparison = {
      ...COMMITTED,
      workingTreeBlobId: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
    };
    expect(ReviewNoteAddRequestSchema.safeParse({ ...note, comparison }).success).toBe(false);
  });

  it("refuses a note whose first line comes after its last", () => {
    expect(ReviewNoteAddRequestSchema.safeParse({ ...note, startLine: 43 }).success).toBe(false);
  });
});

describe("session.reviewNoteRemove", () => {
  it("refuses a discard that names no note", () => {
    const request = { sessionId: SESSION_ID, noteIds: [] };
    expect(ReviewNoteRemoveRequestSchema.safeParse(request).success).toBe(false);
  });
});

describe("session.reviewNoteList", () => {
  it("accepts the held set with a stranded note", () => {
    const { sessionId: _session, ...location } = note;
    const set = {
      notes: [
        {
          ...location,
          quote: "  return retry(login);",
          stranded: true,
          createdAt: "2026-09-29T17:00:00.000Z",
          updatedAt: "2026-09-29T17:05:00.000Z",
        },
      ],
    };
    expect(ReviewNoteSetSchema.safeParse(set).success).toBe(true);
  });
});
