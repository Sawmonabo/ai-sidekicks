// The match count: `match_count(session_search_index, column)`, the full-text index's count of the
// matches `highlight()` would mark in one column of a row, from `match-count.c`. The package build
// compiles that file into a library for this platform; a connection that counts matches loads it.

import { fileURLToPath } from "node:url";

import type { Database } from "better-sqlite3";

// A shared library's suffix on each platform.
const LIBRARY_SUFFIX =
  process.platform === "win32" ? ".dll" : process.platform === "darwin" ? ".dylib" : ".so";

/**
 * Where the package build writes the match count's library: beside this module's build. Three
 * levels up from `{src,dist}/session/search/` is the package, so the source tree and the build find
 * the same file.
 */
export const MATCH_COUNT_LIBRARY_PATH: string = fileURLToPath(
  new URL(`../../../dist/session/search/match-count${LIBRARY_SUFFIX}`, import.meta.url),
);

/**
 * Loads the match count into `connection` through the library's own entry point; SQL's
 * `load_extension()` stays refused. Throws, naming the library, when it is not built or will not
 * load.
 */
export function loadMatchCount(connection: Database): void {
  try {
    connection.loadExtension(MATCH_COUNT_LIBRARY_PATH);
  } catch (error) {
    throw new Error(
      `The search's match count did not load from ${MATCH_COUNT_LIBRARY_PATH}, which the ` +
        `package build compiles (pnpm --filter @ai-sidekicks/runtime-daemon build): ` +
        (error instanceof Error ? error.message : String(error)),
      { cause: error },
    );
  }
}
