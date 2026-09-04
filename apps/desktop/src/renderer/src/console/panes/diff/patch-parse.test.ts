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
