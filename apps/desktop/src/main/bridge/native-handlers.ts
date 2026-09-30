// The operating-system calls main makes for the renderer: the open dialog, the clipboard
// and the system browser.
//
// Each takes what the renderer sent as untrusted input and checks it before acting; each
// takes the Electron module it drives as an argument, so a test calls the real handler.

import { stat } from "node:fs/promises";
import { basename } from "node:path";

import type { OpenDialogOptions, OpenDialogResult, PickedFile } from "@shared/preload-api.js";
import type { FilePathRefOwner, FilePathRefs } from "./file-path-refs.js";

/** The part of Electron's `dialog` the open dialog uses. */
export interface OpenDialogHost {
  showOpenDialog(options: {
    readonly properties: ("openFile" | "multiSelections")[];
  }): Promise<{ readonly canceled: boolean; readonly filePaths: readonly string[] }>;
}

/** The part of Electron's `clipboard` the copy uses. */
export interface ClipboardHost {
  writeText(text: string): void;
}

/**
 * Show the open dialog for a purpose and answer the picked files as tokens, with each
 * file's own name and size. Files only, never a folder: `attachFiles` picks several at once,
 * `importFile` one. Empty when the person canceled.
 */
export async function showOpenDialog(
  host: OpenDialogHost,
  filePathRefs: FilePathRefs,
  owner: FilePathRefOwner,
  options: unknown,
): Promise<OpenDialogResult> {
  const purpose = openDialogPurpose(options);
  const chosen = await host.showOpenDialog({
    properties: purpose === "attachFiles" ? ["openFile", "multiSelections"] : ["openFile"],
  });
  if (chosen.canceled) {
    return { refs: [] };
  }
  const refs: PickedFile[] = [];
  for (const path of chosen.filePaths) {
    const { size } = await stat(path);
    refs.push({ ref: filePathRefs.mint(owner, path), name: basename(path), sizeBytes: size });
  }
  return { refs };
}

/** Put text on the system clipboard. */
export function copyToClipboard(host: ClipboardHost, text: unknown): void {
  if (typeof text !== "string") {
    throw new TypeError("Only text can be copied to the clipboard.");
  }
  host.writeText(text);
}

function openDialogPurpose(options: unknown): OpenDialogOptions["purpose"] {
  const purpose =
    typeof options === "object" && options !== null && "purpose" in options
      ? options.purpose
      : undefined;
  if (purpose !== "attachFiles" && purpose !== "importFile") {
    throw new TypeError("An open dialog is asked for `attachFiles` or `importFile`.");
  }
  return purpose;
}
