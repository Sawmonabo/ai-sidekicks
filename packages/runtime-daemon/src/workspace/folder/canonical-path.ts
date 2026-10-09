// The one key every folder comparison uses. Folders are compared by their resolved path, because
// git prints a tree's folder as it was recorded while the daemon's rows keep the path they were
// given, and on macOS one folder has two spellings (`/var` and `/private/var`). The resolved path
// is then compared by the one path rule the trust envelope uses, which folds case on Windows.

import { realpath } from "node:fs/promises";
import * as nodePath from "node:path";

import { toComparableComponents } from "../trust-envelope.js";

/**
 * The key every folder comparison uses: `folder` resolved, or for a folder that no longer exists
 * its nearest existing parent resolved with the rest joined on, or as given when even its root is
 * missing (a drive unplugged), then put in the trust envelope's comparable form. Two folders are
 * the same folder exactly when their keys are equal. Throws when the folder cannot be resolved for
 * another reason (a permission refusal).
 */
export async function canonicalFolderPath(folder: string): Promise<string> {
  return toComparableComponents(await resolveFolder(nodePath.resolve(folder)), nodePath).join(
    nodePath.sep,
  );
}

// A missing folder keeps its name under its parent's resolved path, so a folder git recorded by
// its real path and one stored through a linked parent resolve alike.
async function resolveFolder(folder: string): Promise<string> {
  try {
    return await realpath(folder);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      throw error;
    }
    const parent = nodePath.dirname(folder);
    if (parent === folder) {
      return folder;
    }
    return nodePath.join(await resolveFolder(parent), nodePath.basename(folder));
  }
}
