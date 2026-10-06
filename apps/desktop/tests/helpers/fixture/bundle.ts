// Where the built app and the Electron launcher are, and whether the build is there. Every
// Electron tier reads these paths, so a tier cannot skip itself by looking where the build does
// not write.

import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The desktop package root (`apps/desktop/`), the working directory every spawn runs in. */
export const PACKAGE_ROOT: string = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

/** The built main entry every Electron tier launches. Produced by `pnpm build:fixtures`. */
export const MAIN_ENTRY_PATH: string = join(PACKAGE_ROOT, "out", "main", "index.js");

/** The `electron` launcher shim, by absolute path so a spawn does not depend on `$PATH`. */
export const ELECTRON_BIN: string = join(PACKAGE_ROOT, "node_modules", ".bin", "electron");

/** The errors `statSync` raises for a path that is not there. */
const MISSING_PATH_CODES: ReadonlySet<string | undefined> = new Set(["ENOENT", "ENOTDIR"]);

/**
 * Whether the built bundle these tiers need is on disk.
 *
 * A tier skips on a missing bundle, since that means the build was not run, not that the app is
 * broken. A directory at the path also counts as absent; any other failure to
 * read it is raised.
 */
export function fixtureBundleExists(): boolean {
  try {
    return statSync(MAIN_ENTRY_PATH).isFile();
  } catch (error: unknown) {
    if (MISSING_PATH_CODES.has((error as NodeJS.ErrnoException).code)) {
      return false;
    }
    throw error;
  }
}
