// Fail-closed wrapper around `node --test`, which exits 0 having run nothing when a glob matches no
// file or when a named path is missing beside real ones (measured on Node 24.18.0 and 26.10.0). A
// lone missing path exits 1. CI gates that rest on a `node --test` glob would stay green after a
// directory rename, so this tool resolves the patterns itself, refuses to spawn when any pattern
// matches nothing, and prints the resolved count. `--min-files` turns that count into a floor.
//
// usage: node tools/run-node-tests.mjs [--min-files=N] [<node-option>...] <pattern>...
//
// An argument starting with `-` other than `--min-files` is forwarded to node ahead of `--test`.
// A pattern is a file path, a directory (its `*.test.mjs` files, recursively) or a glob.

import { globSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const GLOB_METACHARACTERS = /[*?]/;

/**
 * Resolves one pattern to files. A literal file is kept whatever its extension, since dropping a
 * named file is the silent failure this tool prevents. A directory means `<dir>/**\/*.test.mjs`;
 * a glob keeps every file it matches.
 */
function resolvePattern(pattern) {
  let globPattern = pattern;
  if (!GLOB_METACHARACTERS.test(pattern)) {
    let stats;
    try {
      stats = statSync(pattern);
    } catch (error) {
      // A missing path resolves to zero files; the caller turns zero into the failing exit.
      if (error.code !== "ENOENT") throw error;
      return [];
    }
    if (stats.isFile()) return [pattern];
    if (!stats.isDirectory()) return [];
    globPattern = join(pattern, "**", "*.test.mjs");
  }
  return globSync(globPattern).filter((path) => statSync(path).isFile());
}

/**
 * Splits argv into node options to forward, test patterns, and the `--min-files` floor (default 0).
 * Throws when `--min-files` is not given as `--min-files=N` with a non-negative integer.
 */
function parseArguments(argv) {
  const forwardedNodeArguments = [];
  const patterns = [];
  let minimumFiles = 0;

  for (const argument of argv) {
    const minFilesMatch = /^--min-files(?:=(.*))?$/.exec(argument);
    if (minFilesMatch) {
      const rawValue = minFilesMatch[1];
      const parsed = Number(rawValue);
      if (rawValue === undefined || !Number.isInteger(parsed) || parsed < 0) {
        throw new Error(
          `--min-files requires a non-negative integer in \`--min-files=N\` form, got: ${argument}`,
        );
      }
      minimumFiles = parsed;
      continue;
    }
    if (argument.startsWith("-")) {
      forwardedNodeArguments.push(argument);
      continue;
    }
    patterns.push(argument);
  }

  return { forwardedNodeArguments, patterns, minimumFiles };
}

/**
 * Resolves each pattern to files. Returns `perPattern` (for reporting empty matches) and `files`,
 * the sorted, de-duplicated union.
 */
function resolveTestFiles(patterns) {
  const perPattern = patterns.map((pattern) => ({
    pattern,
    files: resolvePattern(pattern),
  }));
  // Overlapping patterns must not run a file twice, and the argv stays deterministic.
  const files = [...new Set(perPattern.flatMap((entry) => entry.files))].sort();
  return { perPattern, files };
}

function main(argv) {
  let parsed;
  try {
    parsed = parseArguments(argv);
  } catch (error) {
    process.stderr.write(`run-node-tests: ${error.message}\n`);
    return 2;
  }
  const { forwardedNodeArguments, patterns, minimumFiles } = parsed;

  if (patterns.length === 0) {
    process.stderr.write(
      "run-node-tests: no test pattern supplied.\n" +
        "usage: node tools/run-node-tests.mjs [--min-files=N] [<node-option>...] <pattern>...\n",
    );
    return 2;
  }

  const { perPattern, files } = resolveTestFiles(patterns);

  // Per pattern, not on the total: a typo'd path must not pass on a working glob's files.
  const emptyPatterns = perPattern.filter((entry) => entry.files.length === 0);
  if (emptyPatterns.length > 0) {
    process.stderr.write(
      `run-node-tests: ${emptyPatterns.length} pattern(s) matched no files — refusing to run.\n`,
    );
    for (const entry of emptyPatterns) {
      process.stderr.write(`  no match: ${entry.pattern}\n`);
    }
    process.stderr.write(
      "A pattern that matches nothing makes `node --test` exit 0 having run no tests.\n",
    );
    return 1;
  }

  if (files.length < minimumFiles) {
    process.stderr.write(
      `run-node-tests: resolved ${files.length} test file(s) but --min-files=${minimumFiles} was required.\n` +
        "Either the suite lost files or a pattern stopped matching them.\n",
    );
    return 1;
  }

  // Printed before the spawn so the count survives a crashing suite.
  process.stdout.write(`run-node-tests: resolved ${files.length} test file(s)\n`);
  for (const entry of perPattern) {
    process.stdout.write(`  ${entry.files.length.toString().padStart(4)}  ${entry.pattern}\n`);
  }

  // Under `node --test`, NODE_TEST_CONTEXT makes a nested run report as a child of the outer one
  // and stop propagating its exit code (measured on Node 24.18.0 and 26.10.0), so a failing suite
  // exits 0.
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;

  // `process.execPath`, not "node": PATH can resolve a different interpreter than the one that
  // resolved the file set.
  const spawned = spawnSync(process.execPath, [...forwardedNodeArguments, "--test", ...files], {
    stdio: "inherit",
    env: childEnvironment,
  });
  if (spawned.error) {
    process.stderr.write(`run-node-tests: failed to spawn node: ${spawned.error.message}\n`);
    return 1;
  }
  // A signal-terminated child reports `status: null`, which must not read as success.
  if (spawned.status === null) {
    process.stderr.write(`run-node-tests: node terminated by signal ${spawned.signal}\n`);
    return 1;
  }
  return spawned.status;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
