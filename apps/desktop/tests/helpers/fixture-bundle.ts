// Where the built console is, and whether it is there.
//
// Both Electron tiers ask two questions before they can run anything: which file
// to hand `_electron.launch`, and whether `pnpm build:fixtures` has actually
// produced it. Neither question is about launching, and answering them beside
// the launcher gave that module a second subject and a second set of imports —
// `node:url`, `dirname`/`resolve`, `statSync` — that the launch itself never
// touches.
//
// The path is a shared constant rather than a spelling each caller repeats, for
// the reason every pin in these tiers exists: two spellings of one location
// drift, and the shape of that drift here is a tier skipping itself because it
// looked for the bundle somewhere the build does not write.

import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..", "..");

/** The built main entry both tiers launch. Produced by `pnpm build:fixtures`. */
export const MAIN_ENTRY_PATH: string = join(PACKAGE_ROOT, "out", "main", "index.js");

/**
 * Whether the built bundle these tiers need is on disk.
 *
 * Used to SKIP with a message rather than fail with a stack trace. A missing
 * bundle is a "you have not run the build" condition, not a defect in the
 * console, and reporting it as a failure trains a reader to ignore the tier.
 *
 * `statSync` rather than `existsSync` so an entry that exists but is a directory
 * or is unreadable is also treated as absent — those fail later and much less
 * legibly, inside Electron's own startup.
 */
export function fixtureBundleExists(): boolean {
  try {
    return statSync(MAIN_ENTRY_PATH).isFile();
  } catch {
    return false;
  }
}
