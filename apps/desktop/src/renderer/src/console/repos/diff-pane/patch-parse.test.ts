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

/**
 * A hunk carrying a bare empty context line, which is how most producers write one.
 *
 * The blank line sits between the leading context and the changed pair, so every
 * number after it is wrong by exactly one if it is dropped — which is what makes this
 * shape the counterexample rather than a curiosity.
 */
const BLANK_CONTEXT_PATCH = [
  "--- packages/contracts/src/event.ts",
  "+++ packages/contracts/src/event.ts",
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
    // The defect. `parsePatch` infers a bare empty line mid-hunk as context and pushes
    // it RAW, so the prefix table answers `undefined` for it and the old `continue`
    // dropped it — the blank vanished from the rendering AND neither counter advanced,
    // putting every number after it one too low. Both halves are asserted, because a
    // fix that rendered the row without advancing the counters would satisfy the first.
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

  it("negative control: a one-space context line still carries no text", () => {
    // Without this, treating `""` as context could be a fix that also dropped the
    // prefix character from a real context line — an off-by-one in the other
    // direction, invisible on a blank and wrong on every line that has one.
    const lines = linesOfFirstHunk(
      [
        "--- packages/contracts/src/event.ts",
        "+++ packages/contracts/src/event.ts",
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

describe("parseUnifiedPatch — a body line this parser cannot place", () => {
  it("is refused by the parse rather than reaching the renderer short", () => {
    // The unrecognised-prefix branch in the line mapper is a backstop and not a path:
    // `parsePatch` pushes a body line only where its operation is ` `, `+`, `-`, or
    // `\`, and throws on anything else — measured against `diff` 9.0.0's `parseHunk`,
    // not assumed. That guarantee is the LIBRARY'S, which is exactly why the mapper
    // now reports a tripwire instead of a silent `continue`: were a version bump to
    // start passing such a line through, the drop would be visible rather than a hunk
    // rendering short with every later line number low and nothing saying why.
    expect(() =>
      parsePlain(
        [
          "--- packages/contracts/src/event.ts",
          "+++ packages/contracts/src/event.ts",
          "@@ -1,2 +1,2 @@",
          " alpha",
          "?beta",
          "+gamma",
          "",
        ].join("\n"),
      ),
    ).toThrow(/invalid line/);
  });

  it("negative control: the same patch with a real prefix parses", () => {
    // Without this the case above would pass over a parser that refused everything.
    const lines = linesOfFirstHunk(
      [
        "--- packages/contracts/src/event.ts",
        "+++ packages/contracts/src/event.ts",
        "@@ -1,2 +1,2 @@",
        " alpha",
        "-beta",
        "+gamma",
        "",
      ].join("\n"),
    );
    expect(lines.map((line) => line.kind)).toStrictEqual(["context", "delete", "insert"]);
  });
});

describe("parseUnifiedPatch — the header scan splits the way the parser splits", () => {
  it("keeps one hunk on one header when a body line carries a lone carriage return", () => {
    // The defect, and it is reachable: a file with old-Mac endings is ONE line to git,
    // so an added line can carry bare carriage returns — and text about patches can
    // carry an `@@` header inside one. `parsePatch` splits on `\n` and nothing else,
    // while this module's scanner used to split on `\r`, `\v`, `\f` and `\u0085` too.
    // The scanner therefore found a header the parser never saw, and the ordinal
    // pairing put every later hunk on the previous one's header. On that splitter the
    // counts disagree and this parse refuses.
    const patch = [
      "--- packages/contracts/src/event.ts",
      "+++ packages/contracts/src/event.ts",
      "@@ -1,2 +1,2 @@",
      " alpha",
      "-beta",
      "+the header \r@@ -1,1 +1,1 @@ was mispaired",
      "",
    ].join("\n");

    const hunks = parsePlain(patch).files.flatMap((file) => file.hunks);
    expect(hunks.map((hunk) => hunk.header)).toStrictEqual(["@@ -1,2 +1,2 @@"]);
    expect(hunks[0]?.lines.map((line) => line.kind)).toStrictEqual(["context", "delete", "insert"]);
  });

  it("still renders a Windows patch's header without the carriage return on it", () => {
    // The property the old splitter was written for, kept: where a line ENDS is the
    // parser's question and what a header CARRIES is this module's, so the `\r` a CRLF
    // patch leaves on the end is trimmed from the kept text rather than from the split.
    const model = parseUnifiedPatch(
      [
        "--- packages/contracts/src/event.ts",
        "+++ packages/contracts/src/event.ts",
        "@@ -10,2 +10,2 @@ function compute(): number {",
        " const before = 1;",
        "-const value = 1;",
        "+const value = 2;",
        "",
      ].join("\r\n"),
      RUN_ATTRIBUTION,
      COMPARED_STATES,
    );

    expect(model.files[0]?.hunks[0]?.header).toBe("@@ -10,2 +10,2 @@ function compute(): number {");
  });
});

describe("parseUnifiedPatch — the declared headers and the parsed hunks are one count", () => {
  it("negative control: a patch whose counts agree parses, headers verbatim", () => {
    // The guard is a backstop on an agreement that belongs to the pinned library
    // rather than to this module — both walks now split identically, so no patch
    // `parsePatch` accepts reaches it. What this holds is the other direction: the
    // guard refuses nothing it should not, and the headers are the patch's own.
    const model = parsePlain(PLAIN_PATCH);
    expect(model.files.flatMap((file) => file.hunks.map((hunk) => hunk.header))).toStrictEqual([
      "@@ -10,2 +10,2 @@",
      "@@ -1,1 +1,2 @@",
    ]);
  });
});
