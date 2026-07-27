// run-node-tests.mjs — fail-closed wrapper around `node --test`.
//
// WHY THIS EXISTS
// ---------------
// `node --test` treats "resolved nothing" as success. Measured on Node v22.12.0
// (this repo's `engines.node` floor):
//
//   node --test 'no/such/**/*.test.mjs'      -> exit 0, `1..0`, `# tests 0`   SILENT
//   node --test real.test.mjs missing.mjs    -> exit 0, missing path dropped  SILENT
//   node --test missing.mjs                  -> exit 1, "Could not find"      loud
//   node --test <any-directory>              -> exit 1, `not ok 1 - <dir>`    loud
//
// The two silent shapes are the ones that matter. The directory form is loud on this
// floor — Node resolves a bare directory arg as a module specifier and fails it as a
// test (ERR_TEST_FAILURE / "Cannot find module"), whether the directory is empty, holds
// a `.test.mjs`, or holds an unrelated file. This tool resolves directories itself.
//
// `ci-gate` is a required check on `develop` and depends on jobs whose only
// verification is a `node --test` glob. A directory rename therefore turns every
// one of those globs into a zero-match, each job exits 0, and the required check
// reports success having executed no tests at all.
//
// This wrapper resolves the patterns ITSELF, refuses to spawn anything when a
// pattern matches nothing, and prints the resolved count so a silent drop from
// many files to one is legible in the CI log even though it clears the zero check.
// `--min-files` converts that log line into an enforced floor.
//
// USAGE
//   node tools/run-node-tests.mjs [--min-files=N] [<node-option>...] <pattern>...
//
// Any argument starting with `-` other than `--min-files` is forwarded to node
// ahead of `--test` (e.g. `--experimental-strip-types`). Positionals are literal
// file paths, directories, or globs.

import { readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Deliberately NOT `fs.globSync`: on Node 22.12 it emits
// `ExperimentalWarning: globSync is an experimental feature and might change at
// any time`. A required CI gate must not rest on an API with that contract, and
// the warning would pollute every run's log. `readdirSync({ recursive: true })`
// is stable and sufficient for the `<prefix>/**/*.test.mjs` shapes in use.
const GLOB_METACHARACTERS = /[*?]/;

/** Escape one literal glob character for embedding in a RegExp source. */
function escapeRegExpCharacter(character) {
  return character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Translate a single glob path-segment (no `/`) into RegExp source. */
function segmentToRegExpSource(segment) {
  let source = "";
  for (const character of segment) {
    if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += escapeRegExpCharacter(character);
  }
  return source;
}

/**
 * Compile the wildcard-bearing tail of a glob into an anchored RegExp matched
 * against paths relative to the pattern's static prefix.
 *
 * `**` spans zero or more path segments, so `a/**\/b` matches `a/b` as well as
 * `a/x/y/b` — the trailing separator lives inside the quantified group rather
 * than after it.
 */
function compileGlobSegments(segments) {
  let source = "^";
  segments.forEach((segment, index) => {
    const isLastSegment = index === segments.length - 1;
    if (segment === "**") {
      source += isLastSegment ? "(?:[^/]+(?:/[^/]+)*)?" : "(?:[^/]+/)*";
      return;
    }
    source += segmentToRegExpSource(segment);
    if (!isLastSegment) source += "/";
  });
  return new RegExp(`${source}$`);
}

/** Every file beneath `root`, as paths relative to `root` with `/` separators. */
function listFilesBeneath(root) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true, recursive: true });
  } catch {
    // A missing or unreadable prefix is not an error here — it resolves to zero
    // files, and the caller turns zero into the fail-closed exit.
    return [];
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      // `parentPath` is absolute-or-root-relative depending on how readdir was
      // called; normalising through `relative` keeps the match surface stable.
      const absolute = join(entry.parentPath ?? entry.path, entry.name);
      return relative(root, absolute).split(sep).join("/");
    });
}

/**
 * Resolve one positional argument to concrete files.
 *
 * A literal path is returned as-is when it is a file (whatever its extension —
 * silently EXCLUDING a file the caller named is the same invisible-drop bug this
 * tool exists to prevent). A literal directory is treated as
 * `<dir>/**\/*.test.mjs`. A glob is matched against the tree under its static
 * prefix, and every match is included: the pattern already states the filter.
 */
function resolvePattern(pattern) {
  const segments = pattern.split("/");
  const firstMagicIndex = segments.findIndex((segment) => GLOB_METACHARACTERS.test(segment));

  if (firstMagicIndex === -1) {
    let stats;
    try {
      stats = statSync(pattern);
    } catch {
      return [];
    }
    if (stats.isFile()) return [pattern];
    if (!stats.isDirectory()) return [];
    return listFilesBeneath(pattern)
      .filter((relativePath) => relativePath.endsWith(".test.mjs"))
      .map((relativePath) => join(pattern, relativePath));
  }

  const staticPrefix = segments.slice(0, firstMagicIndex).join("/") || ".";
  const matcher = compileGlobSegments(segments.slice(firstMagicIndex));
  return listFilesBeneath(staticPrefix)
    .filter((relativePath) => matcher.test(relativePath))
    .map((relativePath) => join(staticPrefix, relativePath));
}

export function parseArguments(argv) {
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

export function resolveTestFiles(patterns) {
  const perPattern = patterns.map((pattern) => ({
    pattern,
    files: resolvePattern(pattern),
  }));
  // Sorted + de-duplicated so two overlapping patterns cannot run a file twice
  // and the spawned argv is deterministic across machines.
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

  // Fail closed per-pattern, not just on the total: a real glob alongside a
  // typo'd path would otherwise pass on the strength of the working one, which
  // is exactly the silent-drop this tool exists to catch.
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

  // Printed BEFORE the spawn so the count survives even if the suite crashes —
  // this is the line that makes a drop from many files to one legible in CI.
  process.stdout.write(`run-node-tests: resolved ${files.length} test file(s)\n`);
  for (const entry of perPattern) {
    process.stdout.write(`  ${entry.files.length.toString().padStart(4)}  ${entry.pattern}\n`);
  }

  // `node --test` marks the processes it spawns with NODE_TEST_CONTEXT. If this
  // wrapper is itself invoked from inside a test run, the nested `node --test`
  // inherits that marker, reports as a child of the OUTER run, and its exit code
  // stops propagating — a failing suite would come back as 0. That is the same
  // fail-open this tool exists to close, so the marker is dropped unconditionally
  // and the spawned run is always a top-level one. Reproduced on Node v22.12.0;
  // the CI step that runs this tool's own tests through this tool hits it.
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;

  // `process.execPath`, not the string "node": resolving the child from PATH can
  // pick a DIFFERENT interpreter than the one that just resolved the file set
  // (nvm, a shell-profile difference, CI step ordering). The suite then runs on
  // a Node the caller never chose. This pins both halves to one binary.
  const spawned = spawnSync(process.execPath, [...forwardedNodeArguments, "--test", ...files], {
    stdio: "inherit",
    env: childEnvironment,
  });
  if (spawned.error) {
    process.stderr.write(`run-node-tests: failed to spawn node: ${spawned.error.message}\n`);
    return 1;
  }
  // A signal-terminated child reports `status: null`; collapsing that to 0 would
  // reintroduce a false-clean, so it becomes a non-zero exit.
  if (spawned.status === null) {
    process.stderr.write(`run-node-tests: node terminated by signal ${spawned.signal}\n`);
    return 1;
  }
  return spawned.status;
}

/**
 * Direct-invocation guard, so the pure helpers above stay importable from unit
 * tests without spawning anything.
 *
 * Same form as `tools/docs-corpus/bin/pre-commit-runner.ts` § isDirectlyInvoked,
 * and NOT the naive `import.meta.url === \`file://${process.argv[1]}\``: that
 * compares a percent-ENCODED URL against a raw path, so any directory
 * containing a space (or `#`, `?`, non-ASCII) makes the two unequal — the CLI
 * then does nothing and exits 0. `realpathSync` on both sides additionally
 * survives a symlinked invocation (macOS `/tmp` → `/private/tmp`), which the
 * encoding-correct-but-unnormalised spelling does not.
 *
 * A silent no-op here would disable the very check this tool exists to provide.
 */
function isDirectlyInvoked() {
  const invokedPath = process.argv[1];
  if (typeof invokedPath !== "string") return false;
  try {
    return realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // A path that will not resolve to a real file was not this module's entry
    // point, so `false` is the correct answer rather than a swallowed failure.
    return false;
  }
}

if (isDirectlyInvoked()) {
  process.exitCode = main(process.argv.slice(2));
}
