// How Windows spells paths: `\` between components, a drive or share as the root, names compared
// without case as NTFS compares them, and a program's line ended by `\r\n`.

import { win32 } from "node:path";

import type { PathRules } from "./contract.js";

/** The path rules of Windows. */
export const WINDOWS_PATH_RULES: PathRules = {
  sep: win32.sep,
  isAbsolute: (path) => win32.isAbsolute(path),
  parse: (path) => win32.parse(path),
  hasCaseInsensitiveNames: true,
  hasDrivelessRoots: true,
  hasCarriageReturnLineEnds: true,
};
