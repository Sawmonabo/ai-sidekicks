import { describe, expect, it } from "vitest";

import { diffLineText, type DiffLine } from "./diff-model.js";
import { intralineSegments, parseUnifiedPatch } from "./patch-parse.js";

const RUN_ATTRIBUTION = { mode: "run_attributed", runId: "run-1" } as const;
const COMPARED_STATES = { baseRef: "main", headRef: "feat/thing" } as const;

/** A plain unified patch: two files, one hunk each, one modified line pair. */
const PLAIN_PATCH = [
  "--- packages/contracts/src/event.ts",
  "+++ packages/contracts/src/event.ts",
  "@@ -10,2 +10,2 @@",
  " const before = 1;",
  "-const value = compute(previousBudget, 11);",
  "+const value = compute(nextBudget, 11);",
  "--- apps/desktop/src/main.ts",
  "+++ apps/desktop/src/main.ts",
  "@@ -1,1 +1,2 @@",
  " const kept = true;",
  "+const added = true;",
  "",
].join("\n");

function parsePlain(patchText: string): ReturnType<typeof parseUnifiedPatch> {
  return parseUnifiedPatch(patchText, RUN_ATTRIBUTION, COMPARED_STATES);
}

function linesOfFirstHunk(patchText: string): readonly DiffLine[] {
  const hunk = parsePlain(patchText).files[0]?.hunks[0];
  if (hunk === undefined) {
    throw new Error("the patch parsed to no first hunk");
  }
  return hunk.lines;
}

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

  it("segments a modified line pair at its word boundaries, on both sides", () => {
    const [, deletedLine, insertedLine] = linesOfFirstHunk(PLAIN_PATCH);
    expect(deletedLine?.segments.filter((segment) => segment.changed)).toStrictEqual([
      { text: "previousBudget", changed: true },
    ]);
    expect(insertedLine?.segments.filter((segment) => segment.changed)).toStrictEqual([
      { text: "nextBudget", changed: true },
    ]);
    // The segments still reassemble to the line, which is what makes them a view of
    // the text rather than a second copy of it.
    expect(diffLineText(deletedLine as DiffLine)).toBe(
      "const value = compute(previousBudget, 11);",
    );
    expect(diffLineText(insertedLine as DiffLine)).toBe("const value = compute(nextBudget, 11);");
  });

  it("negative control: an unpaired insertion is one unchanged segment", () => {
    // Without this the segmentation case above would pass over a parser that marked
    // every line's whole text as changed. The second file's insertion has no deleted
    // counterpart, so nothing about it is a word-level change.
    const hunk = parsePlain(PLAIN_PATCH).files[1]?.hunks[0];
    const insertedLine = hunk?.lines[1];
    expect(insertedLine?.kind).toBe("insert");
    expect(insertedLine?.segments).toStrictEqual([{ text: "const added = true;", changed: false }]);
  });

  it("pairs a longer delete run with a shorter insert run by ordinal and leaves the surplus whole", () => {
    const lines = linesOfFirstHunk(
      [
        "--- one.ts",
        "+++ one.ts",
        "@@ -1,2 +1,1 @@",
        "-const value = compute(previousBudget, 1);",
        "-const dropped = true;",
        "+const value = compute(nextBudget, 1);",
        "",
      ].join("\n"),
    );
    expect(lines[0]?.segments.filter((segment) => segment.changed)).toStrictEqual([
      { text: "previousBudget", changed: true },
    ]);
    expect(lines[1]?.segments).toStrictEqual([{ text: "const dropped = true;", changed: false }]);
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
