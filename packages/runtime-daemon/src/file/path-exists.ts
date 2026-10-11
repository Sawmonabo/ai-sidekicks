// Whether a path names anything, for the modules that act differently when it does not.

import { stat } from "node:fs/promises";

import { isMissingFileError } from "./missing-error.js";

/** Whether anything is at `path`; any failure but a missing entry is thrown. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (statFailure) {
    if (isMissingFileError(statFailure)) {
      return false;
    }
    throw statFailure;
  }
}
