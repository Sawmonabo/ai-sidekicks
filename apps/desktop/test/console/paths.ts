// Where the console tiers resolve the tree they scan.
//
// `apps/desktop/AGENTS.md` names this file as the home for the path resolver "when
// first needed", and the second tier that reads console source is when: the byte-
// scaling chokepoint scans every module, and the workflows family's library ban
// scans three directories of it. Written twice, the two would agree until one of
// them moved and the other kept scanning a directory that no longer exists — and a
// scan over an empty set passes every assertion in it.
//
// A RESOLVER AND NOT A READER. Enumerating files and reading them is each tier's
// own business: one wants every module under the console, another wants three
// subtrees, and a third will want neither. What they share is the one path that is
// wrong the same way for all of them.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** `apps/desktop`, resolved from this file rather than from a process directory. */
const DESKTOP_PACKAGE_ROOT: string = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The console's source root — the subject every architecture tripwire scans. */
export const CONSOLE_SOURCE_DIRECTORY: string = resolve(
  DESKTOP_PACKAGE_ROOT,
  "src",
  "renderer",
  "src",
  "console",
);
