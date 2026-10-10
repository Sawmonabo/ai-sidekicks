// zsh's startup files, copied into a folder inside the daemon's run folder, which only this
// account may open, for each zsh's `ZDOTDIR` to name. What the system's own startup files write
// beside them, such as the completion dump a system zshrc's `compinit` saves to `$ZDOTDIR`, then
// lands in that account's folder and never in the app's own, which can be read-only or reached by
// every account. A copy whose contents differ from the app's is replaced in one rename, so an
// update never runs an old file and a shell starting meanwhile never reads half of one.

import { chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeFileAtomically } from "../../../file/atomic-write.js";
import { isMissingFileError } from "../../../file/missing-error.js";

// Beside this module in the source and in the build, which copies the folder there.
const ZSH_SOURCE_FOLDER = fileURLToPath(new URL("./scripts/zsh/", import.meta.url));
const ZSH_STARTUP_FILE_NAMES = [".zshenv", ".zprofile", ".zshrc", ".zlogin"] as const;
const ZSH_FOLDER_NAME = "zsh";
const PRIVATE_FOLDER_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

/**
 * Makes `<runFolderPath>/zsh` hold this app's zsh startup files, readable by this account alone,
 * and answers its path. A file whose contents differ from the app's is replaced whole.
 */
export async function prepareZshStartupFolder(runFolderPath: string): Promise<string> {
  const folder = path.join(runFolderPath, ZSH_FOLDER_NAME);
  await mkdir(folder, { recursive: true, mode: PRIVATE_FOLDER_MODE });
  // A folder made earlier keeps its own mode, so the mode is set again.
  await chmod(folder, PRIVATE_FOLDER_MODE);
  await Promise.all(
    ZSH_STARTUP_FILE_NAMES.map(async (fileName) => {
      const source = await readFile(path.join(ZSH_SOURCE_FOLDER, fileName), "utf8");
      const copyPath = path.join(folder, fileName);
      if ((await readCopy(copyPath)) !== source) {
        await writeFileAtomically(copyPath, source, PRIVATE_FILE_MODE);
      }
    }),
  );
  return folder;
}

async function readCopy(copyPath: string): Promise<string | undefined> {
  try {
    return await readFile(copyPath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}
