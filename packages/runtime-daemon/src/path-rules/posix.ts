// How macOS and Linux spell paths: `/` between components, one root, names compared exactly and a
// line ended by a line feed alone.

import { posix } from "node:path";

import type { PathRules } from "./contract.js";

/** The path rules macOS and Linux share. */
export const POSIX_PATH_RULES: PathRules = {
  sep: posix.sep,
  isAbsolute: (path) => posix.isAbsolute(path),
  parse: (path) => posix.parse(path),
  hasCaseInsensitiveNames: false,
  hasDrivelessRoots: false,
  hasCarriageReturnLineEnds: false,
};
