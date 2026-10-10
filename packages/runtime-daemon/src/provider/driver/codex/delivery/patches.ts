// The patch each file a Codex file change touched, with the lines it added and removed, counted
// from the file's own `diff`: an update's unified diff line by line, an added file's every line
// added and a deleted file's every line removed, since Codex sends those files' contents whole.

import type { TranscriptPatchFile } from "@ai-sidekicks/contracts/transcript/content";

import { isPlainObject, readNonEmptyString } from "../../../record-readers.js";
import { countUnifiedDiff } from "../../unified-diff.js";

/** How Codex says a file changed (`PatchChangeKind`). */
type CodexPatchChangeKind = "add" | "delete" | "update";

function readChangeKind(change: Record<string, unknown>): CodexPatchChangeKind | undefined {
  const kind = change["kind"];
  const type = isPlainObject(kind) ? kind["type"] : kind;
  return type === "add" || type === "delete" || type === "update" ? type : undefined;
}

// A whole file's text as patch lines, every one with the same mark.
function markEveryLine(text: string, mark: "+" | "-"): string[] {
  const lines = text.split("\n");
  // A file that ends in a newline leaves one empty piece after it, which is no line.
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines.map((line) => `${mark}${line}`);
}

/** One `FileUpdateChange` as a patch with its counts, or `undefined` when it names no file. */
function readCodexPatchFile(change: unknown): TranscriptPatchFile | undefined {
  if (!isPlainObject(change)) {
    return undefined;
  }
  const path = readNonEmptyString(change, "path");
  const diff = change["diff"];
  const kind = readChangeKind(change);
  if (path === undefined || typeof diff !== "string" || kind === undefined) {
    return undefined;
  }
  if (kind === "update") {
    return { path, patch: diff, ...countUnifiedDiff(diff) };
  }
  const lines = markEveryLine(diff, kind === "add" ? "+" : "-");
  return {
    path,
    patch: lines.join("\n"),
    additions: kind === "add" ? lines.length : 0,
    deletions: kind === "delete" ? lines.length : 0,
  };
}

/** Every file a `fileChange` item's `changes` touched, each with its patch and counts. */
export function readCodexPatchFiles(
  item: Readonly<Record<string, unknown>>,
): TranscriptPatchFile[] {
  const changes = item["changes"];
  if (!Array.isArray(changes)) {
    return [];
  }
  return changes.flatMap((change) => {
    const file = readCodexPatchFile(change);
    return file === undefined ? [] : [file];
  });
}
