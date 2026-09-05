// The unified patch text a fixture shape is generated as, before anything parses it.
//
// SPLIT FROM `diff-fixture.ts` ON THE SEAM BETWEEN A SHAPE AND ITS BYTES. That module
// declares the shapes, holds the named fixtures, and turns a parsed patch into a
// `ConsoleDiffModel` — the two things a patch cannot carry included. This one writes
// the patch: hunk headers with the line numbers the format produces, the extended
// headers a rename and a mode change carry, and the `\ No newline at end of file`
// marker. Two subjects, and the file that held both was doing two jobs, which
// `apps/desktop/AGENTS.md` rejects.
//
// IT GENERATES A PATCH RATHER THAN A MODEL, and that is the whole reason this text
// exists: `Spec-023 §Console Libraries` adopts `diff` 9.0.0 for parse and intraline
// compute, and a fixture that hand-built hunk headers, line numbers, and word-level
// segments would be a second implementation of exactly that — one the tiers would then
// be measuring INSTEAD of the parser a wire will call.

import {
  EXTENDED_HEADER_FIXTURE_FILES,
  TERMINAL_NEWLINE_FIXTURE_FILE,
  type DiffFixtureShape,
} from "./diff-fixture-shapes.js";
import type { DiffLineKind } from "./diff-model.js";

/**
 * The kinds a generated hunk cycles through, so every row branch is reached.
 *
 * Deletion BEFORE insertion, which is not cosmetic: a unified patch expresses a
 * modified line as a delete run immediately followed by an insert run, and that
 * adjacency is what `patch-parse.ts` pairs to compute the intraline segments. A
 * cycle that emitted the insertion first would generate a patch no producer writes
 * and would silently drop every word-level highlight from the fixture.
 */
const LINE_KIND_CYCLE = ["context", "delete", "insert"] as const;

/** The whole change set as unified patch text, which is what a producer would send. */
export function buildPatchText(shape: DiffFixtureShape): string {
  const patches: string[] = [];
  for (let fileOrdinal = 0; fileOrdinal < shape.fileCount; fileOrdinal += 1) {
    const path = fixtureFilePath(fileOrdinal);
    // No `a/` and `b/` prefixes and no `diff --git` line: this is a plain unified
    // patch, so the path the parser reports is the path written here, with nothing
    // to strip and no chance of a re-rooted file reaching a surface.
    const lines: string[] = [`--- ${path}`, `+++ ${path}`];
    for (let hunkOrdinal = 0; hunkOrdinal < shape.hunksPerFile; hunkOrdinal += 1) {
      const start = hunkOrdinal * 40 + 1;
      const body = hunkBodyLines(shape, fileOrdinal, start);
      lines.push(
        `@@ -${String(start)},${String(countSide(body, "-"))} +${String(start)},${String(
          countSide(body, "+"),
        )} @@`,
        ...body,
      );
    }
    patches.push(lines.join("\n"));
  }
  // BEFORE the header files, which is not arrangement: the binary file's patch is the
  // one whose body a parser reads by looking at what follows it, and a plain unified
  // patch appended after it is read as part of that file rather than as its own.
  if (shape.terminalNewlineFile) {
    patches.push(terminalNewlinePatch());
  }
  if (shape.extendedHeaderFiles) {
    patches.push(...extendedHeaderPatches());
  }
  return `${patches.join("\n")}\n`;
}

/**
 * One file that lost its terminating newline and changed nothing else.
 *
 * WRITTEN OUT RATHER THAN GENERATED, because the whole subject is one exact pair of
 * lines: the deletion and the insertion carry the SAME text, and the only thing that
 * tells them apart is the marker on the second. A generator parameterised over this
 * would have one call site and would hide the one property the case is about.
 *
 * The marker is on the inserted side alone, which is what removing a newline looks
 * like — a reader has to be able to see which side the file ends without one on.
 */
function terminalNewlinePatch(): string {
  const { path, lastLine } = TERMINAL_NEWLINE_FIXTURE_FILE;
  return [
    `--- ${path}`,
    `+++ ${path}`,
    "@@ -1,3 +1,3 @@",
    ' import { terminate } from "./terminate.js";',
    " ",
    `-${lastLine}`,
    `+${lastLine}`,
    "\\ No newline at end of file",
  ].join("\n");
}

/**
 * One file per extended-header kind, each changing nothing else, as git writes them.
 *
 * GIT-STYLE, WHICH THE REST OF THIS PATCH DELIBERATELY IS NOT. None of these changes
 * has any representation in a plain unified patch at all — `rename from`, `copy from`,
 * `old mode`, and the binary marker are git extended headers, read only under a
 * `diff --git` header — so each file carries one, with the `a/` and `b/` prefixes that
 * header requires. `parsePatch` reads `isGit` per file, so the plain files above keep
 * their paths verbatim and these are stripped, which is the mixture a real change set
 * produces too when only some of its files moved.
 *
 * No hunks anywhere below: the whole change is in the headers, which is the case the
 * surfaces used to draw as `+0 −0` under a bare path.
 */
function extendedHeaderPatches(): readonly string[] {
  const { renamed, copied, modeChanged, binary } = EXTENDED_HEADER_FIXTURE_FILES;
  return [
    [
      `diff --git a/${renamed.from} b/${renamed.to}`,
      "similarity index 100%",
      `rename from ${renamed.from}`,
      `rename to ${renamed.to}`,
    ].join("\n"),
    [
      `diff --git a/${copied.from} b/${copied.to}`,
      "similarity index 100%",
      `copy from ${copied.from}`,
      `copy to ${copied.to}`,
    ].join("\n"),
    [
      `diff --git a/${modeChanged.path} b/${modeChanged.path}`,
      `old mode ${modeChanged.from}`,
      `new mode ${modeChanged.to}`,
    ].join("\n"),
    [
      `diff --git a/${binary.path} b/${binary.path}`,
      "index 1a2b3c4..5d6e7f8 100644",
      `Binary files a/${binary.path} and b/${binary.path} differ`,
    ].join("\n"),
  ];
}

/** One hunk's prefixed body lines, cycling the three kinds. */
function hunkBodyLines(
  shape: DiffFixtureShape,
  fileOrdinal: number,
  start: number,
): readonly string[] {
  const body: string[] = [];
  for (let lineOrdinal = 0; lineOrdinal < shape.linesPerHunk; lineOrdinal += 1) {
    const kind = LINE_KIND_CYCLE[lineOrdinal % LINE_KIND_CYCLE.length] ?? "context";
    body.push(
      `${PATCH_PREFIX_BY_KIND[kind]}${fixtureLineText(kind, fileOrdinal, start + lineOrdinal)}`,
    );
  }
  return body;
}

/** How many of a hunk's lines exist on one side. A context line exists on both. */
function countSide(body: readonly string[], changedPrefix: "-" | "+"): number {
  return body.filter((line) => line.startsWith(" ") || line.startsWith(changedPrefix)).length;
}

/** The prefix character the unified format gives each kind. */
const PATCH_PREFIX_BY_KIND: Readonly<Record<DiffLineKind, string>> = {
  context: " ",
  insert: "+",
  delete: "-",
};

/**
 * One generated line's text.
 *
 * The two changed kinds differ in exactly one identifier, which is what makes the
 * word diff over the pair produce the three-segment shape a renderer's intraline
 * case is written against — an unchanged head, one changed run, an unchanged tail.
 */
function fixtureLineText(kind: DiffLineKind, fileOrdinal: number, lineNumber: number): string {
  if (kind === "context") {
    return `  const module${padded(fileOrdinal)} = read(${String(lineNumber)});`;
  }
  const identifier = kind === "insert" ? "nextBudget" : "previousBudget";
  return `  const value = compute(${identifier}, ${String(lineNumber)});`;
}

/** The path a generated file is written under, in both the patch and the model. */
function fixtureFilePath(fileOrdinal: number): string {
  return `packages/runtime-daemon/src/module-${padded(fileOrdinal)}.ts`;
}

function padded(ordinal: number): string {
  return String(ordinal).padStart(2, "0");
}
