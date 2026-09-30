// Where the built console is, and whether it is there. Both Electron tiers need the file to hand
// `_electron.launch` and to know whether `pnpm build:fixtures` produced it; one shared path stops
// a tier skipping itself because it looked where the build does not write.

import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..", "..");

/** The built main entry both tiers launch. Produced by `pnpm build:fixtures`. */
export const MAIN_ENTRY_PATH: string = join(PACKAGE_ROOT, "out", "main", "index.js");

/**
/**
 * Whether the built bundle these tiers need is on disk.
 *
 * A tier skips with a message on a missing bundle, since that means the build was not run, not
 * that the console is broken. `statSync` rather than `existsSync` so a directory or unreadable
 * entry also counts as absent; those otherwise fail illegibly inside Electron's startup.
 */
export function fixtureBundleExists(): boolean {
  try {
    return statSync(MAIN_ENTRY_PATH).isFile();
  } catch {
    return false;
  }
}
