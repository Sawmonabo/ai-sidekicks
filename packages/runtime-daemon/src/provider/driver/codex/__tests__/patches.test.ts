// The patch counts a Codex file change shows: an update counted from its hunks, and an added or
// deleted file, whose contents Codex sends whole, counted line by line.

import { describe, expect, it } from "vitest";

import { readCodexPatchFiles } from "../delivery/patches.js";

describe("readCodexPatchFiles", () => {
  it("counts each file's added and removed lines", () => {
    const files = readCodexPatchFiles({
      type: "fileChange",
      changes: [
        {
          path: "schema.sql",
          kind: { type: "update", move_path: null },
          // Codex writes hunks with no file header, so `--- old` is a removed line whose text
          // starts with `--`, not a header.
          diff: "@@ -1,3 +1,3 @@\n keep\n--- old\n-gone\n+++ new\n",
        },
        { path: "notes.md", kind: { type: "add" }, diff: "one\ntwo\n" },
        { path: "old.txt", kind: { type: "delete" }, diff: "only line" },
      ],
    });

    expect(files).toStrictEqual([
      {
        path: "schema.sql",
        patch: "@@ -1,3 +1,3 @@\n keep\n--- old\n-gone\n+++ new\n",
        additions: 1,
        deletions: 2,
      },
      { path: "notes.md", patch: "+one\n+two", additions: 2, deletions: 0 },
      { path: "old.txt", patch: "-only line", additions: 0, deletions: 1 },
    ]);
  });
});
