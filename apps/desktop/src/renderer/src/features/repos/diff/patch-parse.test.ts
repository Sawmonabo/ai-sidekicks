// The unified-patch parser: the hunk headers the patch declared, each side's line numbers, the
// paths it names, the file shapes whose change lives only in the extended headers (rename, copy,
// mode change, binary), and the marker that ends a file without a newline.

import { describe, expect, it } from "vitest";

import { diffLineText } from "./model.js";
import { parseUnifiedPatch } from "./patch-parse.js";
import {
  COMPARED_STATES,
  PLAIN_PATCH,
  linesOfFirstHunk,
  parsePlainPatch,
} from "#test/helpers/patch-parsing.js";

/**
 * A git-style patch whose header carries what a reconstruction loses: the section context
 * after the closing `@@`, and a one-line range spelled without its count.
 */
const SECTION_CONTEXT_PATCH = [
  "diff --git a/apps/desktop/src/main.ts b/apps/desktop/src/main.ts",
  "--- a/apps/desktop/src/main.ts",
  "+++ b/apps/desktop/src/main.ts",
  "@@ -10 +10 @@ function createApplicationWindow(): BrowserWindow {",
  "-const value = compute(previousBudget, 11);",
  "+const value = compute(nextBudget, 11);",
  "",
].join("\n");

describe("parseUnifiedPatch — the hunk header is the patch's own", () => {
  it("keeps the section context git appends after the closing marker", () => {
    // The navigational value of a hunk header is which function the change is in. `diff`
    // drops it, so it is read off the raw line.
    expect(parsePlainPatch(SECTION_CONTEXT_PATCH).files[0]?.hunks[0]?.header).toBe(
      "@@ -10 +10 @@ function createApplicationWindow(): BrowserWindow {",
    );
  });

  it("hands each file's hunks their own declared headers, in order", () => {
    const model = parsePlainPatch(PLAIN_PATCH);
    expect(model.files[0]?.hunks[0]?.header).toBe("@@ -10,2 +10,2 @@");
    expect(model.files[1]?.hunks[0]?.header).toBe("@@ -1,1 +1,2 @@");
  });

  it("carries no line ending into the header of a patch written with CRLF", () => {
    const header = parseUnifiedPatch(
      SECTION_CONTEXT_PATCH.split("\n").join("\r\n"),
      COMPARED_STATES,
    ).files[0]?.hunks[0]?.header;
    expect(header).toBe("@@ -10 +10 @@ function createApplicationWindow(): BrowserWindow {");
  });

  it("does not read a body line that looks like a header as one", () => {
    // Every body line carries a prefix, so a deleted line whose text is a hunk header reads as
    // `-@@ …` and never matches; otherwise every later hunk would get the wrong header.
    const patchText = [
      "--- a/docs/patch-format.md",
      "+++ b/docs/patch-format.md",
      "@@ -1,2 +1,2 @@ Section",
      " A header looks like this:",
      "-@@ -10,2 +10,2 @@ oldSection",
      "+@@ -10,3 +10,3 @@ newSection",
      "",
    ].join("\n");
    const model = parseUnifiedPatch(patchText, COMPARED_STATES);
    expect(model.files[0]?.hunks).toHaveLength(1);
    expect(model.files[0]?.hunks[0]?.header).toBe("@@ -1,2 +1,2 @@ Section");
  });

  it("refuses a patch with a hunk its headers do not declare, rather than shifting them", () => {
    // The parser takes the malformed `@@ @@ …` line as a hunk the header scan does not see, so
    // the first hunk would be drawn under the second one's numbers.
    const patchText = [
      "--- a/notes.md",
      "+++ b/notes.md",
      "@@ @@ -1 +1 @@",
      "-a",
      "+b",
      "@@ -5 +5 @@",
      "-c",
      "+d",
      "",
    ].join("\n");
    expect(() => parseUnifiedPatch(patchText, COMPARED_STATES)).toThrow(/fewer `@@` headers/u);
  });
});

describe("parseUnifiedPatch", () => {
  it("carries the caller's compared states rather than reading them", () => {
    // They are not in the patch text, so producing them from the body would invent them.
    const model = parsePlainPatch(PLAIN_PATCH);
    expect(model.baseRef).toBe("main");
    expect(model.headRef).toBe("feat/thing");
  });

  it("reads every file in a multi-file patch, under the path the patch names", () => {
    expect(parsePlainPatch(PLAIN_PATCH).files.map((file) => file.path)).toStrictEqual([
      "packages/contracts/src/event/session-event.ts",
      "apps/desktop/src/main.ts",
    ]);
  });

  it("numbers the two sides independently", () => {
    // The deleted line has no head number, the inserted line no base number, and the context
    // line before them has both.
    const [contextLine, deletedLine, insertedLine] = linesOfFirstHunk(PLAIN_PATCH);
    expect(contextLine).toMatchObject({ kind: "context", baseLineNumber: 10, headLineNumber: 10 });
    expect(deletedLine?.kind).toBe("delete");
    expect(deletedLine?.baseLineNumber).toBe(11);
    expect(deletedLine?.headLineNumber).toBeUndefined();
    expect(insertedLine?.kind).toBe("insert");
    expect(insertedLine?.headLineNumber).toBe(11);
    expect(insertedLine?.baseLineNumber).toBeUndefined();
  });

  it("strips the git prefixes only on a patch that declared itself git-style", () => {
    const model = parsePlainPatch(
      [
        "diff --git a/apps/desktop/src/main.ts b/apps/desktop/src/main.ts",
        "index 1111111..2222222 100644",
        "--- a/apps/desktop/src/main.ts",
        "+++ b/apps/desktop/src/main.ts",
        "@@ -1,1 +1,1 @@",
        "-const kept = false;",
        "+const kept = true;",
        "",
      ].join("\n"),
    );
    expect(model.files[0]?.path).toBe("apps/desktop/src/main.ts");
  });

  it("keeps a plain patch's path that genuinely begins with `b/`", () => {
    // The strip is conditional: stripping unconditionally would re-root this file.
    const model = parsePlainPatch(
      ["--- b/tool.ts", "+++ b/tool.ts", "@@ -1,1 +1,1 @@", "-a", "+b", ""].join("\n"),
    );
    expect(model.files[0]?.path).toBe("b/tool.ts");
  });

  it("names a deleted file by its old side, because the new side is absent", () => {
    const model = parsePlainPatch(
      ["--- gone.ts", "+++ /dev/null", "@@ -1,1 +0,0 @@", "-const gone = true;", ""].join("\n"),
    );
    expect(model.files[0]?.path).toBe("gone.ts");
  });
});

/**
 * A hunk carrying a bare empty context line, which is how most producers write one. The blank
 * sits between the leading context and the changed pair, so dropping it puts every number
 * after it off by one.
 */
const BLANK_CONTEXT_PATCH = [
  "--- packages/contracts/src/event/session-event.ts",
  "+++ packages/contracts/src/event/session-event.ts",
  "@@ -1,4 +1,4 @@",
  " alpha",
  "",
  "-beta",
  "+gamma",
  " delta",
  "",
].join("\n");

describe("parseUnifiedPatch — an empty context line is a line", () => {
  it("renders the blank and keeps every later number on the line it belongs to", () => {
    // `parsePatch` pushes a bare empty mid-hunk line raw, so the prefix table answers
    // `undefined` for it. Both halves are asserted: the row must render and the counters must
    // advance, or every later number is one too low.
    const lines = linesOfFirstHunk(BLANK_CONTEXT_PATCH);

    expect(lines.map((line) => line.kind)).toStrictEqual([
      "context",
      "context",
      "delete",
      "insert",
      "context",
    ]);
    expect(lines.map(diffLineText)).toStrictEqual(["alpha", "", "beta", "gamma", "delta"]);
    expect(lines.map((line) => line.baseLineNumber)).toStrictEqual([1, 2, 3, undefined, 4]);
    expect(lines.map((line) => line.headLineNumber)).toStrictEqual([1, 2, undefined, 3, 4]);
  });

  it("reads a one-space context line as carrying no text", () => {
    // Treating `""` as context must not also drop the prefix from a real context line, an
    // off-by-one invisible on a blank.
    const lines = linesOfFirstHunk(
      [
        "--- packages/contracts/src/event/session-event.ts",
        "+++ packages/contracts/src/event/session-event.ts",
        "@@ -1,2 +1,2 @@",
        " ",
        "-beta",
        "+gamma",
        "",
      ].join("\n"),
    );

    expect(lines[0]?.kind).toBe("context");
    expect(lines[0] === undefined ? undefined : diffLineText(lines[0])).toBe("");
    expect(lines[1]?.baseLineNumber).toBe(2);
  });
});

describe("parseUnifiedPatch — the header scan splits the way the parser splits", () => {
  it("keeps one hunk on one header when a body line carries a lone carriage return", () => {
    // Reachable: a file with old-Mac endings is one line to git, so an added line can carry
    // bare carriage returns and an `@@` header. `parsePatch` splits on `\n` only, so a
    // scanner that also split on `\r`, `\v`, `\f` or `\u0085` would find a header the parser
    // never saw and misalign every later hunk. The counts disagree and this parse refuses.
    const patch = [
      "--- packages/contracts/src/event/session-event.ts",
      "+++ packages/contracts/src/event/session-event.ts",
      "@@ -1,2 +1,2 @@",
      " alpha",
      "-beta",
      "+the header \r@@ -1,1 +1,1 @@ was mispaired",
      "",
    ].join("\n");

    const hunks = parsePlainPatch(patch).files.flatMap((file) => file.hunks);
    expect(hunks.map((hunk) => hunk.header)).toStrictEqual(["@@ -1,2 +1,2 @@"]);
    expect(hunks[0]?.lines.map((line) => line.kind)).toStrictEqual(["context", "delete", "insert"]);
  });
});

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
    // A mapping that kept only the path and `hunks` would show this file as `+0 −0` under a
    // bare path and lose the name a reader is looking for.
    const file = parsePlainPatch(RENAME_ONLY_PATCH).files[0];
    expect(file?.path).toBe("docs/decisions/after.md");
    expect(file?.renamedFrom).toBe("docs/decisions/before.md");
    expect(file?.hunks).toStrictEqual([]);
  });

  it("carries both modes where the patch declared the file's mode changed", () => {
    const file = parsePlainPatch(MODE_ONLY_PATCH).files[0];
    expect(file?.path).toBe("scripts/release.sh");
    expect(file?.modeChange).toStrictEqual({ from: "100644", to: "100755" });
  });

  it("carries the binary marker, which is the only thing such a patch says", () => {
    const file = parsePlainPatch(BINARY_PATCH).files[0];
    expect(file?.path).toBe("assets/logo.png");
    expect(file?.binary).toBe(true);
  });

  it("tells a copy from a rename, because the source still exists", () => {
    // Folding the two would tell a reader the original is gone. `parsePatch` reads `copy from`
    // into the same `oldFileName` with a different flag, so the flag tells them apart.
    const file = parsePlainPatch(COPY_ONLY_PATCH).files[0];
    expect(file?.copiedFrom).toBe("config/base.yml");
    expect(file?.renamedFrom).toBeUndefined();
  });

  it("keeps the header fact beside the hunks when a rename also changed lines", () => {
    const file = parsePlainPatch(RENAME_WITH_HUNK_PATCH).files[0];
    expect(file?.renamedFrom).toBe("src/old-name.ts");
    expect(file?.hunks).toHaveLength(1);
    expect(file?.hunks[0]?.header).toBe("@@ -1,2 +1,2 @@");
  });

  it("does not read a created file's single mode as a mode change", () => {
    // `parsePatch` fills `newMode` from `new file mode`, and a new file had no mode before; a
    // member read off one side would render "mode undefined → 100644" on every new file.
    const created = [
      "diff --git a/src/fresh.ts b/src/fresh.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/fresh.ts",
      "@@ -0,0 +1,1 @@",
      "+const fresh = true;",
      "",
    ].join("\n");
    expect(parsePlainPatch(created).files[0]?.modeChange).toBeUndefined();
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
    // The deleted and inserted text are the same characters, so the marker on the insertion is
    // the entire content of the change.
    const lines = linesOfFirstHunk(NEWLINE_REMOVED_PATCH);
    const [, deleted, inserted] = lines;

    expect(diffLineText(deleted!)).toBe(diffLineText(inserted!));
    expect(deleted?.noNewlineAtEnd).toBeUndefined();
    expect(inserted?.noNewlineAtEnd).toBe(true);
  });

  it("draws no row for the marker, because the file has no such line", () => {
    // Three lines, not four: the marker annotates the line above it and does not touch the
    // numbering.
    const lines = linesOfFirstHunk(NEWLINE_REMOVED_PATCH);
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => line.kind)).toStrictEqual(["context", "delete", "insert"]);
    expect(lines.map((line) => line.baseLineNumber)).toStrictEqual([1, 2, undefined]);
    expect(lines.map((line) => line.headLineNumber)).toStrictEqual([1, undefined, 2]);
  });
});
