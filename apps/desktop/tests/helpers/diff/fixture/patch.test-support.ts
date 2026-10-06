// The unified patch text a fixture shape is generated as, before anything parses it.
//
// It writes hunk headers with the line numbers the format produces, the extended headers a rename
// and a mode change carry, and the `\ No newline at end of file` marker; shapes and the model are
// `shapes.ts` and `model.ts`. It generates a patch rather than a model so the
// tiers measure the parser a wire will call, not a second implementation of it.

import {
  EXTENDED_HEADER_FIXTURE_FILES,
  TERMINAL_NEWLINE_FIXTURE_FILE,
  type DiffFixtureShape,
} from "./shapes.js";
import type { DiffLineKind } from "#renderer/features/repos/diff/model.js";

/**
 * The kinds a generated hunk cycles through, so every row branch is reached.
 *
 * Deletion comes before insertion: a unified patch writes a modified line as a delete run followed
 * by an insert run, and `patch-parse.ts` pairs that adjacency to compute intraline segments.
 */
const LINE_KIND_CYCLE = ["context", "delete", "insert"] as const;

/** The whole change set as unified patch text, which is what a producer would send. */
export function buildPatchText(shape: DiffFixtureShape): string {
  const patches: string[] = [];
  for (let fileOrdinal = 0; fileOrdinal < shape.fileCount; fileOrdinal += 1) {
    const path = fixtureFilePath(fileOrdinal);
    // A plain unified patch: no `a/` and `b/` prefixes and no `diff --git` line, so the parser
    // reports the path as written.
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
  // Before the header files: a plain unified patch appended after the binary file's patch would
  // be read as part of that file.
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
 * Written out rather than generated: the deletion and the insertion carry the same text, and only
 * the marker on the inserted side, which is what removing a newline looks like, tells them apart.
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
 * These changes have no representation in a plain unified patch, so each file carries a
 * `diff --git` header with the `a/` and `b/` prefixes it requires. `parsePatch` reads `isGit` per
 * file, so the plain files keep their paths verbatim and these are stripped, as in a real change
 * set. There are no hunks: a view that read only hunks would draw `+0 −0` under a bare path.
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
 * The two changed kinds differ in one identifier, so the word diff over the pair yields the
 * unchanged head, one changed run and unchanged tail a renderer's intraline case is written
 * against.
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
