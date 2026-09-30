// The OS calls main makes for the renderer. Each checks the renderer's untrusted input before
// acting and takes the Electron module it drives as an argument, so a test calls the handler.

import { stat } from "node:fs/promises";
import { basename } from "node:path";

import type { OpenDialogPurpose, OpenDialogResults, PickedFile } from "@shared/preload-api.js";
import type { FilePathRefOwner, FilePathRefs } from "./file-path-refs.js";

/** The part of Electron's `dialog` the open dialog uses. */
export interface OpenDialogHost {
  showOpenDialog(options: {
    readonly properties: ("openFile" | "openDirectory" | "multiSelections")[];
  }): Promise<{ readonly canceled: boolean; readonly filePaths: readonly string[] }>;
}

/** The part of Electron's `clipboard` the copy uses. */
export interface ClipboardHost {
  writeText(text: string): void;
}

/** What the platform's chooser lets a person pick, for each purpose. */
const OPEN_DIALOG_PROPERTIES: Readonly<
  Record<OpenDialogPurpose, ("openFile" | "openDirectory" | "multiSelections")[]>
> = {
  attachFiles: ["openFile", "multiSelections"],
  importFile: ["openFile"],
  pickFolder: ["openDirectory"],
};

/**
 * Show the open dialog for a purpose and answer what was picked as tokens: files with their
 * name and size for `attachFiles` (several) and `importFile` (one), or one folder token
 * (`null` on cancel) for `pickFolder`. Throws a `TypeError` for an unknown purpose.
 */
export async function showOpenDialog(
  host: OpenDialogHost,
  filePathRefs: FilePathRefs,
  owner: FilePathRefOwner,
  options: unknown,
): Promise<OpenDialogResults[OpenDialogPurpose]> {
  const purpose = openDialogPurpose(options);
  const chosen = await host.showOpenDialog({ properties: OPEN_DIALOG_PROPERTIES[purpose] });
  if (chosen.canceled) {
    return purpose === "pickFolder" ? null : { refs: [] };
  }
  if (purpose === "pickFolder") {
    const [folder] = chosen.filePaths;
    return folder === undefined ? null : filePathRefs.mint(owner, folder);
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

function openDialogPurpose(options: unknown): OpenDialogPurpose {
  const purpose =
    typeof options === "object" && options !== null && "purpose" in options
      ? options.purpose
      : undefined;
  if (purpose !== "attachFiles" && purpose !== "importFile" && purpose !== "pickFolder") {
    throw new TypeError("An open dialog is asked for `attachFiles`, `importFile` or `pickFolder`.");
  }
  return purpose;
}
