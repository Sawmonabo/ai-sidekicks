// `repo.fileRead`: a gap read names its blob and its side together, so its line numbers match
// the diff the reader is looking at.
import { describe, expect, it } from "vitest";

import { RepoFileReadRequestSchema } from "../repo-git-reads.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const BLOB_ID_SHA1 = "3b18e512dba79e4c8300dd08aeb37f8e728b8dad";

describe("repo.fileRead", () => {
  it("reads a file by path, or a gap by path, blob and side together", () => {
    const read = (extra: Record<string, unknown>) =>
      RepoFileReadRequestSchema.safeParse({ sessionId: SESSION_ID, path: "src/app.ts", ...extra })
        .success;
    expect(read({})).toBe(true);
    expect(
      read({ blobId: BLOB_ID_SHA1, side: "working-tree", lines: { from: 40, count: 30 } }),
    ).toBe(true);
    expect(read({ blobId: BLOB_ID_SHA1 })).toBe(false);
    expect(read({ side: "committed" })).toBe(false);
    expect(read({ lines: { from: 0, count: 30 } })).toBe(false);
  });
});
