// The daemon's diff reads as the views' model: what happened to each file comes from the wire,
// since a file with no patch has nothing else to say it, and a tool call's patches split across
// pages are joined whole.

import type { GitDiffReadResponse } from "@ai-sidekicks/contracts/git/local";
import { describe, expect, it } from "vitest";

import { diffFileListReading } from "./file-entries.js";
import { diffFileChangeNotes } from "./model.js";
import { diffModelFromPatchList, diffModelFromRead } from "./read-model.js";
import { DiffFlowRowsByFile } from "./rows/flow.js";

const RESPONSE: GitDiffReadResponse = {
  head: "feature",
  base: "main",
  files: [
    { path: "assets/logo.png", kind: "added", binary: true, additions: 0, deletions: 0 },
    { path: "assets/old.png", kind: "deleted", binary: true, additions: 0, deletions: 0 },
    {
      path: "bin/tool",
      kind: "modified",
      modeChanged: true,
      binary: true,
      additions: 0,
      deletions: 0,
    },
    {
      path: "src/next.ts",
      oldPath: "src/previous.ts",
      kind: "renamed",
      additions: 0,
      deletions: 0,
    },
    {
      path: "src/kept.ts",
      kind: "modified",
      additions: 1,
      deletions: 1,
      patch: ["--- a/src/kept.ts", "+++ b/src/kept.ts", "@@ -1 +1 @@", "-a", "+b", ""].join("\n"),
    },
  ],
};

describe("diffModelFromRead", () => {
  it("words each file's change on its Review row and header as the daemon named it", () => {
    const model = diffModelFromRead(RESPONSE);
    const rowNotes = diffFileListReading(model, "")
      .entries.filter((entry) => entry.kind === "file")
      .map((entry) => entry.changeNotes);
    expect(rowNotes).toStrictEqual([["added"], ["deleted"], ["mode changed"], ["renamed"], []]);
    expect(model.files.map((file) => diffFileChangeNotes(file, "header"))).toStrictEqual([
      ["added"],
      ["deleted"],
      ["mode changed"],
      ["renamed from src/previous.ts"],
      [],
    ]);
    // A binary file has no patch to read a mode change from, and the flow still writes both.
    expect(new DiffFlowRowsByFile(model).rowsOf(2).bodyNotes).toStrictEqual([
      "mode changed",
      "No preview for this file",
    ]);
  });
});

describe("diffModelFromPatchList", () => {
  it("joins a patch and a raw text split where a page ends, and starts afresh at offset zero", () => {
    const patch = ["--- a/src/kept.ts", "+++ b/src/kept.ts", "@@ -1 +1 @@", "-a", "+b", ""].join(
      "\n",
    );
    const cut = patch.indexOf("@@");
    const model = diffModelFromPatchList(
      [
        {
          files: [{ path: "src/kept.ts", patch: patch.slice(0, cut), additions: 1, deletions: 1 }],
          next: { fileIndex: 0, offset: cut },
        },
        {
          files: [
            { path: "src/kept.ts", patch: patch.slice(cut), additions: 1, deletions: 1 },
            { path: "notes.md", unavailable: "unreadable", rawPatch: "*** Begin" },
          ],
          next: { fileIndex: 1, offset: 9 },
        },
        {
          files: [{ path: "notes.md", unavailable: "unreadable", rawPatch: " Patch\n" }],
          next: { fileIndex: 2, offset: 0 },
        },
        { files: [{ path: "gone.md", unavailable: "absent" }], next: null },
      ],
      { baseRef: "main", headRef: "feature" },
    );

    expect(model.files.map((file) => file.path)).toStrictEqual([
      "src/kept.ts",
      "notes.md",
      "gone.md",
    ]);
    expect(model.files[0]?.patch).toBe(patch);
    expect(model.files[0]?.hunks).toHaveLength(1);
    expect(model.files[1]?.patchUnavailable).toStrictEqual({
      reason: "unreadable",
      rawPatch: "*** Begin Patch\n",
    });
    expect(model.files[2]?.patchUnavailable).toStrictEqual({ reason: "absent" });
  });
});
