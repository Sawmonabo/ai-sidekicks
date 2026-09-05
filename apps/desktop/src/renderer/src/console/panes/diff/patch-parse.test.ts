import { describe, expect, it } from "vitest";

import { diffLineText, type DiffLine } from "./diff-model.js";
import { intralineSegments, parseUnifiedPatch } from "./patch-parse.js";
import {
  COMPARED_STATES,
  PLAIN_PATCH,
  RUN_ATTRIBUTION,
  linesOfFirstHunk,
  parsePlain,
} from "./patch-parse.test-support.js";

/**
 * A git-style patch whose header carries both things a reconstruction loses: the
 * section context after the closing `@@`, and a one-line range spelled without its
 * count.
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
    // The whole navigational value of a git hunk header: which function the change
    // is inside. `diff`'s `StructuredPatchHunk` drops it, so it is read off the raw
    // line rather than composed from the four numbers that survive.
    expect(parsePlain(SECTION_CONTEXT_PATCH).files[0]?.hunks[0]?.header).toBe(
      "@@ -10 +10 @@ function createApplicationWindow(): BrowserWindow {",
    );
  });

  it("keeps a one-line range spelled the way the patch spelled it", () => {
    const header = parsePlain(SECTION_CONTEXT_PATCH).files[0]?.hunks[0]?.header ?? "";
    expect(header.startsWith("@@ -10 +10 @@")).toBe(true);
  });

  it("negative control: the header is not the reconstruction from the four numbers", () => {
    // Exactly what composing `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`
    // produces for this hunk. It renders as a plausible header and is not the one the
    // patch declared, which is why the reconstruction was invisible until read.
    expect(parsePlain(SECTION_CONTEXT_PATCH).files[0]?.hunks[0]?.header).not.toBe(
      "@@ -10,1 +10,1 @@",
    );
  });

  it("hands each file's hunks their own declared headers, in order", () => {
    const model = parsePlain(PLAIN_PATCH);
    expect(model.files[0]?.hunks[0]?.header).toBe("@@ -10,2 +10,2 @@");
    expect(model.files[1]?.hunks[0]?.header).toBe("@@ -1,1 +1,2 @@");
  });

  it("carries no line ending into the header of a patch written with CRLF", () => {
    const header = parseUnifiedPatch(
      SECTION_CONTEXT_PATCH.split("\n").join("\r\n"),
      RUN_ATTRIBUTION,
      COMPARED_STATES,
    ).files[0]?.hunks[0]?.header;
    expect(header).toBe("@@ -10 +10 @@ function createApplicationWindow(): BrowserWindow {");
  });

  it("negative control: a body line that looks like a header is not read as one", () => {
    // Every body line carries a prefix, so a deleted line whose text is itself a hunk
    // header reads as `-@@ …` and never matches. Without that the header list would
    // gain an entry and every hunk after it would be handed the wrong one.
    const patchText = [
      "--- a/docs/patch-format.md",
      "+++ b/docs/patch-format.md",
      "@@ -1,2 +1,2 @@ Section",
      " A header looks like this:",
      "-@@ -10,2 +10,2 @@ oldSection",
      "+@@ -10,3 +10,3 @@ newSection",
      "",
    ].join("\n");
    const model = parseUnifiedPatch(patchText, RUN_ATTRIBUTION, COMPARED_STATES);
    expect(model.files[0]?.hunks).toHaveLength(1);
    expect(model.files[0]?.hunks[0]?.header).toBe("@@ -1,2 +1,2 @@ Section");
  });
});

describe("parseUnifiedPatch", () => {
  it("carries the create call's attribution and compared states rather than reading them", () => {
    // Neither is in the patch text — `Spec-011` puts both on the create call — so a
    // parser that produced them from the body would be inventing them.
    const model = parsePlain(PLAIN_PATCH);
    expect(model.attribution).toStrictEqual(RUN_ATTRIBUTION);
    expect(model.baseRef).toBe("main");
    expect(model.headRef).toBe("feat/thing");
  });

  it("reads every file in a multi-file patch, under the path the patch names", () => {
    expect(parsePlain(PLAIN_PATCH).files.map((file) => file.path)).toStrictEqual([
      "packages/contracts/src/event.ts",
      "apps/desktop/src/main.ts",
    ]);
  });

  it("carries the hunk header the patch declared, verbatim", () => {
    expect(parsePlain(PLAIN_PATCH).files[0]?.hunks[0]?.header).toBe("@@ -10,2 +10,2 @@");
  });

  it("numbers the two sides independently", () => {
    // The claim a hand-built fixture gets wrong by advancing both in lockstep: the
    // deleted line has no head number and the inserted line has no base number, and
    // the context line before them has both.
    const [contextLine, deletedLine, insertedLine] = linesOfFirstHunk(PLAIN_PATCH);
    expect(contextLine).toMatchObject({ kind: "context", baseLineNumber: 10, headLineNumber: 10 });
    expect(deletedLine?.kind).toBe("delete");
    expect(deletedLine?.baseLineNumber).toBe(11);
    expect(deletedLine?.headLineNumber).toBeUndefined();
    expect(insertedLine?.kind).toBe("insert");
    expect(insertedLine?.headLineNumber).toBe(11);
    expect(insertedLine?.baseLineNumber).toBeUndefined();
  });

  it("gives a parsed hunk no preceding context, because a patch carries none", () => {
    for (const file of parsePlain(PLAIN_PATCH).files) {
      for (const hunk of file.hunks) {
        expect(hunk.precedingContext).toStrictEqual([]);
      }
    }
  });

  it("gives every line one whole-line segment, computing no word diff", () => {
    // THE BOUND, asserted where it used to be spent. This parser once ran
    // `diffWordsWithSpace` over every delete/insert pair before it returned, so a
    // forty-file change set paid for the whole change set before the virtualizer
    // placed a row. The split is derived per rendered row now — `intraline-segments.ts`
    // owns it — and a parsed line carries its text and nothing else.
    for (const line of linesOfFirstHunk(PLAIN_PATCH)) {
      expect(line.segments).toStrictEqual([{ text: diffLineText(line), changed: false }]);
    }
  });

  it("negative control: the same pair through the intraline seam does split", () => {
    // Without this the claim above would pass over a patch the word diff finds
    // nothing in. This pair IS one it splits, so the parser's single segment is a
    // decision rather than an absence.
    const [, deletedLine, insertedLine] = linesOfFirstHunk(PLAIN_PATCH);
    const pair = intralineSegments(
      diffLineText(deletedLine as DiffLine),
      diffLineText(insertedLine as DiffLine),
    );
    expect(pair.deleted.filter((segment) => segment.changed)).toStrictEqual([
      { text: "previousBudget", changed: true },
    ]);
  });

  it("strips the git prefixes only on a patch that declared itself git-style", () => {
    const model = parsePlain(
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

  it("negative control: a plain patch keeps a path that genuinely begins with `b/`", () => {
    // The strip is conditional for exactly this case. A parser that stripped
    // unconditionally would re-root this file, which `diff-model.ts` forbids.
    const model = parsePlain(
      ["--- b/tool.ts", "+++ b/tool.ts", "@@ -1,1 +1,1 @@", "-a", "+b", ""].join("\n"),
    );
    expect(model.files[0]?.path).toBe("b/tool.ts");
  });

  it("names a deleted file by its old side, because the new side is absent", () => {
    const model = parsePlain(
      ["--- gone.ts", "+++ /dev/null", "@@ -1,1 +0,0 @@", "-const gone = true;", ""].join("\n"),
    );
    expect(model.files[0]?.path).toBe("gone.ts");
  });

  it("draws no row for a no-newline marker, which annotates a line rather than being one", () => {
    const lines = linesOfFirstHunk(
      [
        "--- tail.ts",
        "+++ tail.ts",
        "@@ -1,1 +1,1 @@",
        "-const tail = 1;",
        "\\ No newline at end of file",
        "+const tail = 2;",
        "",
      ].join("\n"),
    );
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.kind)).toStrictEqual(["delete", "insert"]);
  });
});

describe("intralineSegments", () => {
  it("reads both sides off one alignment, so the two highlights agree", () => {
    const pair = intralineSegments("keep alpha keep", "keep beta keep");
    expect(pair.deleted).toStrictEqual([
      { text: "keep ", changed: false },
      { text: "alpha", changed: true },
      { text: " keep", changed: false },
    ]);
    expect(pair.inserted).toStrictEqual([
      { text: "keep ", changed: false },
      { text: "beta", changed: true },
      { text: " keep", changed: false },
    ]);
  });

  it("keeps a whitespace-only change visible", () => {
    // `diffWordsWithSpace` rather than `diffWords` for exactly this: an indentation
    // change is a real change, and a tokenizer that discarded whitespace would
    // report the two lines as identical.
    const pair = intralineSegments("  value", "    value");
    expect(pair.deleted.some((segment) => segment.changed)).toBe(true);
    expect(pair.inserted.some((segment) => segment.changed)).toBe(true);
  });

  it("negative control: identical text is one unchanged segment on both sides", () => {
    const pair = intralineSegments("const kept = true;", "const kept = true;");
    expect(pair.deleted).toStrictEqual([{ text: "const kept = true;", changed: false }]);
    expect(pair.inserted).toStrictEqual([{ text: "const kept = true;", changed: false }]);
  });
});
