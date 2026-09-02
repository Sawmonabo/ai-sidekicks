// The one place a tier resolves this package's real Vitest projects.
//
// Two architecture tests ask questions whose answer is "what does the runner
// actually do" rather than "what does the config file appear to say":
// `vitest-project-globs.test.ts` asks which project would discover a given file,
// and `ci-tier-coverage.test.ts` asks which projects exist at all. Both answers
// have to come from `createVitest` — a matcher or a project list of our own could
// agree with the config and still disagree with the run — so the resolution lives
// here once rather than in each of them.
//
// Resolving is not running. `createVitest` loads the config and constructs the
// `TestProject` instances; no suite is collected, no browser is launched, and the
// whole call costs about two hundred milliseconds.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createVitest, type TestProject } from "vitest/node";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..", "..");

/** The config whose projects the package's `test:*` scripts each select one of. */
const VITEST_CONFIG_PATH = join(PACKAGE_ROOT, "vitest.config.ts");

export interface ResolvedVitestProjects {
  /** The real `TestProject` instances, in config order. */
  readonly projects: readonly TestProject[];
  /** Release the runner's resources. Every caller does this in `afterAll`. */
  readonly close: () => Promise<void>;
}

/**
 * Load `vitest.config.ts` and hand back the projects it declares.
 *
 * Throws rather than returning an empty list when the config resolves nothing:
 * every claim a caller makes about the project set is vacuously true over an
 * empty one, and a config that failed to resolve would otherwise report green.
 */
export async function resolveVitestProjects(): Promise<ResolvedVitestProjects> {
  const vitest = await createVitest("test", {
    watch: false,
    run: true,
    root: PACKAGE_ROOT,
    config: VITEST_CONFIG_PATH,
  });
  if (vitest.projects.length === 0) {
    await vitest.close();
    throw new Error(`${VITEST_CONFIG_PATH} resolved no projects`);
  }
  return {
    projects: vitest.projects,
    close: () => vitest.close(),
  };
}
