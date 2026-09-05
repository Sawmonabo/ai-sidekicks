// The file shapes a patch can describe, and the marker that ends a file without a
// newline.
//
// THE BODY OF A PATCH is `patch-parse.test.ts` — the hunk header, the line kinds, and
// the intraline segments a changed pair produces. Every case here is about a file
// whose CHANGE IS NOT IN ITS LINES: a rename, a mode change, a binary file, or a copy
// that the extended headers carry and the hunk body does not mention at all — and the
// marker that says a file ends without a newline, which is the one line in a patch
// that describes the line before it rather than itself.

import { describe, expect, it } from "vitest";

import { diffLineText } from "./diff-model.js";
import { PLAIN_PATCH, linesOfFirstHunk, parsePlain } from "./patch-parse.test-support.js";

/** A rename with no textual change at all: the whole change is in the headers. */
const RENAME_ONLY_PATCH = [
  "diff --git a/docs/decisions/before.md b/docs/decisions/after.md",
  "similarity index 100%",
  "rename from docs/decisions/before.md",
  "rename to docs/decisions/after.md",
  "",
].join("\n");

/** A file whose only change is that it became executable. */
const MODE_ONLY_PATCH = [
  "diff --git a/scripts/release.sh b/scripts/release.sh",
  "old mode 100644",
  "new mode 100755",
  "",
].join("\n");

/** Bytes that differ, which a unified patch cannot express as lines. */
const BINARY_PATCH = [
  "diff --git a/assets/logo.png b/assets/logo.png",
  "index 1a2b3c4..5d6e7f8 100644",
  "Binary files a/assets/logo.png and b/assets/logo.png differ",
  "",
].join("\n");

/** A copy, which git emits only where the source still exists. */
const COPY_ONLY_PATCH = [
  "diff --git a/config/base.yml b/config/staging.yml",
  "similarity index 100%",
  "copy from config/base.yml",
  "copy to config/staging.yml",
  "",
].join("\n");

/** A rename that also changed lines: both the header fact and the hunks survive. */
const RENAME_WITH_HUNK_PATCH = [
  "diff --git a/src/old-name.ts b/src/new-name.ts",
  "similarity index 87%",
  "rename from src/old-name.ts",
  "rename to src/new-name.ts",
  "--- a/src/old-name.ts",
  "+++ b/src/new-name.ts",
  "@@ -1,2 +1,2 @@",
  " const kept = true;",
  "-const value = 1;",
  "+const value = 2;",
  "",
].join("\n");

describe("parseUnifiedPatch — a change that lives only in the extended headers", () => {
  it("carries the path a rename came from, with the git prefix stripped", () => {
    // The bug, exercised: the mapping kept the selected path and `hunks`, so this
    // file reached both surfaces as `+0 −0` under `docs/decisions/after.md` and the
    // name a reader is actually looking for was gone.
    const file = parsePlain(RENAME_ONLY_PATCH).files[0];
    expect(file?.path).toBe("docs/decisions/after.md");
    expect(file?.renamedFrom).toBe("docs/decisions/before.md");
    expect(file?.hunks).toStrictEqual([]);
  });

  it("carries both modes where the patch declared the file's mode changed", () => {
    const file = parsePlain(MODE_ONLY_PATCH).files[0];
    expect(file?.path).toBe("scripts/release.sh");
    expect(file?.modeChange).toStrictEqual({ from: "100644", to: "100755" });
  });

  it("carries the binary marker, which is the only thing such a patch says", () => {
    const file = parsePlain(BINARY_PATCH).files[0];
    expect(file?.path).toBe("assets/logo.png");
    expect(file?.binary).toBe(true);
  });

  it("tells a copy from a rename, because the source still exists", () => {
    // Folding the two would tell a reader the original is gone. `parsePatch` reads
    // `copy from` into the same `oldFileName` and a different flag, so the two are
    // told apart by the flag rather than by the path.
    const file = parsePlain(COPY_ONLY_PATCH).files[0];
    expect(file?.copiedFrom).toBe("config/base.yml");
    expect(file?.renamedFrom).toBeUndefined();
  });

  it("keeps the header fact beside the hunks when a rename also changed lines", () => {
    const file = parsePlain(RENAME_WITH_HUNK_PATCH).files[0];
    expect(file?.renamedFrom).toBe("src/old-name.ts");
    expect(file?.hunks).toHaveLength(1);
    expect(file?.hunks[0]?.header).toBe("@@ -1,2 +1,2 @@");
  });

  it("negative control: an ordinary change declares none of the four", () => {
    // Without this, a mapping that stamped every file `binary` or invented a
    // `renamedFrom` from the `---` line would pass every case above, and every
    // ordinary file in a change set would carry a note about a change it did not
    // have.
    for (const file of parsePlain(PLAIN_PATCH).files) {
      expect(file.renamedFrom).toBeUndefined();
      expect(file.copiedFrom).toBeUndefined();
      expect(file.modeChange).toBeUndefined();
      expect(file.binary).toBeUndefined();
    }
  });

  it("negative control: a created file's single mode is not a mode CHANGE", () => {
    // `parsePatch` fills `newMode` from `new file mode`, and a file that appeared
    // did not have its mode changed — it had no mode before. A member read off one
    // side would render "mode undefined → 100644" on every new file in a change set.
    const created = [
      "diff --git a/src/fresh.ts b/src/fresh.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/fresh.ts",
      "@@ -0,0 +1,1 @@",
      "+const fresh = true;",
      "",
    ].join("\n");
    expect(parsePlain(created).files[0]?.modeChange).toBeUndefined();
  });
});

describe("parseUnifiedPatch — the marker that says a file has no final newline", () => {
  /** Removing the terminator: the two rows carry the SAME text, and only one ends. */
  const NEWLINE_REMOVED_PATCH = [
    "--- packages/contracts/src/tail.ts",
    "+++ packages/contracts/src/tail.ts",
    "@@ -1,2 +1,2 @@",
    " const kept = true;",
    "-const tail = terminate(entries);",
    "+const tail = terminate(entries);",
    "\\ No newline at end of file",
    "",
  ].join("\n");

  /** Both sides already ended without one, and the change is inside the line. */
  const NEITHER_SIDE_TERMINATED_PATCH = [
    "--- packages/contracts/src/tail.ts",
    "+++ packages/contracts/src/tail.ts",
    "@@ -1,2 +1,2 @@",
    " const kept = true;",
    "-const tail = terminate(previous);",
    "\\ No newline at end of file",
    "+const tail = terminate(next);",
    "\\ No newline at end of file",
    "",
  ].join("\n");

  it("carries the marker on both rows where the patch marked both", () => {
    const lines = linesOfFirstHunk(NEITHER_SIDE_TERMINATED_PATCH);
    expect(lines.map((line) => line.noNewlineAtEnd)).toStrictEqual([undefined, true, true]);
  });

  it("marks only the side the patch marked, which is what a newline-only change is", () => {
    // The subject the marker exists for: the deleted and the inserted text are the
    // same characters, so the marker on the insertion is the entire content of the
    // change. A parser that dropped it left two rows nothing could tell apart.
    const lines = linesOfFirstHunk(NEWLINE_REMOVED_PATCH);
    const [, deleted, inserted] = lines;

    expect(diffLineText(deleted!)).toBe(diffLineText(inserted!));
    expect(deleted?.noNewlineAtEnd).toBeUndefined();
    expect(inserted?.noNewlineAtEnd).toBe(true);
  });

  it("draws no row for the marker, because the file has no such line", () => {
    // Three lines, not four: the marker annotates the line above it and the numbering
    // of both sides is untouched by it.
    const lines = linesOfFirstHunk(NEWLINE_REMOVED_PATCH);
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => line.kind)).toStrictEqual(["context", "delete", "insert"]);
    expect(lines.map((line) => line.baseLineNumber)).toStrictEqual([1, 2, undefined]);
    expect(lines.map((line) => line.headLineNumber)).toStrictEqual([1, undefined, 2]);
  });

  it("negative control: an ordinary last-line change marks nothing", () => {
    // Without this, a parser that stamped every hunk's last line would report that
    // every file in a change set ends without a newline — which is the opposite
    // error and just as unreadable.
    for (const line of linesOfFirstHunk(PLAIN_PATCH)) {
      expect(line.noNewlineAtEnd).toBeUndefined();
    }
  });
});
