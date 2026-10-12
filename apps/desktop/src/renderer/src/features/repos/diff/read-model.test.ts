// The daemon's diff read as the pane's model: what happened to each file comes from the wire,
// since a file with no patch has nothing else to say it.

import type { GitflowDiffReadResponse } from "@ai-sidekicks/contracts/gitflow/local";
import { describe, expect, it } from "vitest";

import { diffFileListReading } from "./file-entries.js";
import { diffFileChangeNotes } from "./model.js";
import { diffModelFromRead } from "./read-model.js";
import { DiffFlowRowsByFile } from "./rows/flow.js";

const RESPONSE: GitflowDiffReadResponse = {
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
      "binary — contents not shown",
    ]);
  });
});
