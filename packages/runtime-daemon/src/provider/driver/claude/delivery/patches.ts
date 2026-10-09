// The patch a Claude Code file-changing call made, with the lines it added and removed, read from
// the call's own result: `gitDiff` where Claude Code sends one, which carries its own counts, else
// the result's `structuredPatch` hunks, counted line by line. A call whose result carries neither
// reads as a file whose patch cannot be shown.

import type { TranscriptPatchFile } from "@ai-sidekicks/contracts/transcript/content";

import { isPlainObject, readNonEmptyString } from "../../../record-readers.js";
import { countUnifiedDiff } from "../../unified-diff.js";

// The tools whose result is one file's change.
const CLAUDE_FILE_CHANGING_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
]);

/** Whether a tool's result is one file's change, read for its patch. */
export function isClaudeFileChangingTool(toolName: string): boolean {
  return CLAUDE_FILE_CHANGING_TOOL_NAMES.has(toolName);
}

function readCount(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function readGitDiff(result: Record<string, unknown>): TranscriptPatchFile | undefined {
  const gitDiff = result["gitDiff"];
  if (!isPlainObject(gitDiff)) {
    return undefined;
  }
  const path = readNonEmptyString(gitDiff, "filename");
  const patch = gitDiff["patch"];
  const additions = readCount(gitDiff, "additions");
  const deletions = readCount(gitDiff, "deletions");
  if (
    path === undefined ||
    typeof patch !== "string" ||
    additions === undefined ||
    deletions === undefined
  ) {
    return undefined;
  }
  return { path, patch, additions, deletions };
}

// Each hunk as its unified header and lines, counted as any unified diff is.
function readStructuredPatch(
  path: string,
  hunks: readonly unknown[],
): TranscriptPatchFile | undefined {
  const text: string[] = [];
  for (const hunk of hunks) {
    if (!isPlainObject(hunk) || !Array.isArray(hunk["lines"])) {
      return undefined;
    }
    const oldStart = readCount(hunk, "oldStart");
    const oldLines = readCount(hunk, "oldLines");
    const newStart = readCount(hunk, "newStart");
    const newLines = readCount(hunk, "newLines");
    if (
      oldStart === undefined ||
      oldLines === undefined ||
      newStart === undefined ||
      newLines === undefined
    ) {
      return undefined;
    }
    text.push(`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`);
    for (const line of hunk["lines"]) {
      if (typeof line !== "string") {
        return undefined;
      }
      text.push(line);
    }
  }
  const patch = text.join("\n");
  return { path, patch, ...countUnifiedDiff(patch) };
}

/**
 * The patch one file-changing call's result carries, from `gitDiff` first, then from its
 * `structuredPatch`; `unavailable` for a result naming its file but carrying neither, and
 * `undefined` for a result that names no file. `toolUseResult` is untrusted provider output.
 */
export function readClaudePatchFile(toolUseResult: unknown): TranscriptPatchFile | undefined {
  if (!isPlainObject(toolUseResult)) {
    return undefined;
  }
  const path =
    readNonEmptyString(toolUseResult, "filePath") ??
    readNonEmptyString(toolUseResult, "notebook_path");
  if (path === undefined) {
    return undefined;
  }
  const fromGitDiff = readGitDiff(toolUseResult);
  if (fromGitDiff !== undefined) {
    return fromGitDiff;
  }
  const hunks = toolUseResult["structuredPatch"];
  const fromHunks = Array.isArray(hunks) ? readStructuredPatch(path, hunks) : undefined;
  return fromHunks ?? { path, unavailable: "absent" };
}
