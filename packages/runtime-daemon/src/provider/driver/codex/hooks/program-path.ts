// Where the program Codex runs as the daemon's hooks sits: beside this module, with its extension,
// in the source tree and in the build alike. It reads its own location and imports nothing else of
// the daemon's, so the build keeps it in a file of its own beside the program.

import { fileURLToPath } from "node:url";

import { moduleUrlBeside } from "../../../../worker/module-url.js";

/** The hook program's absolute path, which every hook command Codex runs names. */
export const CODEX_HOOK_PROGRAM_PATH: string = fileURLToPath(
  moduleUrlBeside(import.meta.url, "program"),
);
