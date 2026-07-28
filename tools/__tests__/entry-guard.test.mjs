// Entry-guard invariant for every CLI script in the repo that discriminates
// "imported as a module" from "invoked as a command".
//
// THE BUG THIS PINS
// -----------------
// The naive idiom `import.meta.url === \`file://${process.argv[1]}\`` compares a
// percent-ENCODED URL against a raw filesystem path. Any path containing a space
// (or `#`, `?`, non-ASCII) makes the two unequal, so the guard never fires: the
// CLI does nothing, prints nothing, and exits 0. A second axis breaks the
// encoding-correct-but-unnormalised spelling `process.argv[1] === fileURLToPath(...)`:
// an invocation through a symlink (macOS `/tmp` → `/private/tmp`, or a checkout
// under a symlink) also compares unequal.
//
// Both axes produce a SILENT no-op with a success exit code, which for a gate
// script means "reported success having done nothing".
//
// Each script is invoked here through a symlinked directory whose name contains
// a space, so one fixture exercises both axes at once, and asserted to actually
// run. Copying the scripts to a temp directory would break their relative
// imports, so the symlink points at the real repo root.
//
// WHY THE LIST IS ASSERTED COMPLETE
// ---------------------------------
// A hand-maintained fixture list is itself the failure mode this file pins: a
// guarded CLI that nobody adds is simply never spawned, and the suite reports
// clean over a script it did not run. That is exactly what happened — the list
// enumerated only `.mjs` scripts, so the three guarded TypeScript CLIs under
// `tools/docs-corpus/bin/` were invisible to it, `pre-commit-runner.ts` (the
// whole lefthook docs-corpus gate) among them. `the list is complete` below
// re-derives the guarded set from the source tree on every run so the fixture
// cannot silently under-cover again. Catalogued as CAT-10 in
// `docs/operations/failure-mode-catalog.md`.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  symlinkSync,
  unlinkSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// A marked table whose column does not sum to its declared Total. Chosen
// because the violation is entirely WITHIN the file: the gate reaches a
// non-zero verdict without resolving any repo-relative path, so it behaves
// identically whether the script is reached through the real root or through
// the spaced symlink. A fixture that cited a real doc would make the assertion
// depend on how each script resolves the repo, which is not what is under test.
const UNBALANCED_TOTAL_FIXTURE = [
  "# Fixture",
  "",
  '<!-- corpus:total-check column="Count" -->',
  "",
  "| Item | Count |",
  "| --- | --- |",
  "| a | 1 |",
  "| b | 1 |",
  "| **Total** | 99 |",
  "",
].join("\n");

// Each entry is invoked with arguments guaranteed to make a RUNNING script exit
// non-zero with a diagnostic. That turns "did the guard fire?" into an
// observable: guard fires => non-zero + diagnostic; guard no-ops => 0 + silence.
//
// `args` is a function of the fixture directory so entries that need a scratch
// input can build an absolute path to it. `nodeOptions` carries the flags a
// script needs to load at all — the TypeScript CLIs are run from source under
// `--experimental-strip-types` exactly as CI and lefthook run them, since a
// guard that only fires under a build step is not the guard those callers use.
const CLI_SCRIPTS = [
  { relativePath: "tools/run-node-tests.mjs", args: () => ["no/such/**/*.test.mjs"] },
  {
    relativePath: ".claude/skills/plan-execution/scripts/post-merge-housekeeper.mjs",
    args: () => [],
  },
  {
    relativePath: ".claude/skills/plan-execution/scripts/rebuild-shipment-manifest.mjs",
    args: () => [],
  },
  {
    relativePath: ".claude/skills/plan-execution/scripts/validate-review-response.mjs",
    args: () => [],
  },
  // Runs as a required CI check (`.github/workflows/docs-corpus.yml`, the
  // plan-cite Gate-4 survey step). A no-op here is a green check over an
  // unrun gate, so this entry is the load-bearing one in the list.
  { relativePath: ".claude/skills/plan-execution/scripts/preflight.mjs", args: () => [] },
  // Carries NO entry guard and needs none: it consults `import.meta.url` only
  // to resolve the repo root and `process.argv` only to parse flags, and
  // exports nothing. It is spawned here anyway, because the invariant this file
  // really pins is "the CLI does not silently no-op when invoked through a
  // hostile path" — worth asserting whether or not a guard mediates it.
  //
  // Listing it is also what lets this file have no exemption channel at all. An
  // earlier revision exempted it and validated the exemption by export count;
  // that proxy would have kept passing if the file later grew a real (and
  // broken) guard while still exporting nothing, and the exemption filter would
  // have hidden it from the comparison below — a false clean manufactured by
  // the very mechanism meant to prevent one (Codex, round 5).
  { relativePath: ".claude/skills/plan-execution/scripts/codex-gate.mjs", args: () => [] },
  // The lefthook pre-commit docs-corpus gate. A silent no-op here disables
  // every pre-commit corpus check at once, which makes this the highest-blast-
  // radius guard in the repo.
  {
    relativePath: "tools/docs-corpus/bin/pre-commit-runner.ts",
    nodeOptions: ["--experimental-strip-types"],
    args: (fixtureDirectory) => [join(fixtureDirectory, "unbalanced-total.md")],
  },
  {
    relativePath: "tools/docs-corpus/bin/table-total-check.ts",
    nodeOptions: ["--experimental-strip-types"],
    args: (fixtureDirectory) => [join(fixtureDirectory, "unbalanced-total.md")],
  },
  // Reads its inputs from PR_TITLE / PR_BRANCH and the changed-file list on fd
  // 0, so the failing invocation is a malformed JSON line rather than a bad
  // argument. Writes its diagnostic to stdout, not stderr — hence the combined
  // -stream assertion below.
  {
    relativePath: "tools/docs-corpus/bin/lane-boundary-check.ts",
    nodeOptions: ["--experimental-strip-types"],
    args: () => [],
    stdin: "{\n",
    env: { PR_TITLE: "chore(repo): entry-guard fixture", PR_BRANCH: "chore/entry-guard-fixture" },
  },
];

// Node prints an ExperimentalWarning to stderr for `--experimental-strip-types`
// whether or not the script body ever runs, so an unfiltered stderr check would
// pass for a no-op TypeScript CLI — the exact false clean this file exists to
// catch. Strip the interpreter's own chatter before asserting the script spoke.
function withoutInterpreterWarnings(streamText) {
  return (streamText ?? "")
    .split("\n")
    .filter((line) => !/^\(node:\d+\)/.test(line) && !/^\(Use `node --trace-warnings/.test(line))
    .join("\n")
    .trim();
}

/**
 * Symlink the repo under a directory name containing a space.
 *
 * The symlink is unlinked explicitly before the containing directory is removed:
 * a recursive delete over a link pointing at the working repo is not a risk worth
 * taking on the strength of "fs.rm does not follow symlinks".
 */
function withSpacedSymlinkedRepo(runBody) {
  const containingDirectory = mkdtempSync(join(tmpdir(), "entry-guard-"));
  const spacedRepoLink = join(containingDirectory, "repo root with spaces");
  symlinkSync(REPO_ROOT, spacedRepoLink, "dir");
  writeFileSync(join(containingDirectory, "unbalanced-total.md"), UNBALANCED_TOTAL_FIXTURE);
  try {
    return runBody(spacedRepoLink, containingDirectory);
  } finally {
    unlinkSync(spacedRepoLink);
    rmSync(containingDirectory, { recursive: true, force: true });
  }
}

test("the fixture path genuinely exercises the encoding axis", () => {
  // Without this, a tmpdir that happened to contain no space would leave every
  // test below passing while proving nothing about the bug.
  withSpacedSymlinkedRepo((spacedRepoLink) => {
    const scriptPath = join(spacedRepoLink, "tools/run-node-tests.mjs");
    assert.notEqual(
      `file://${scriptPath}`,
      pathToFileURL(scriptPath).href,
      "fixture path must differ between naive concatenation and correct URL encoding",
    );
    assert.match(pathToFileURL(scriptPath).href, /%20/);
  });
});

for (const { relativePath, args, nodeOptions = [], stdin = "", env } of CLI_SCRIPTS) {
  test(`${relativePath}: does not silently no-op through a spaced, symlinked path`, () => {
    withSpacedSymlinkedRepo((spacedRepoLink, fixtureDirectory) => {
      const scriptPath = join(spacedRepoLink, relativePath);
      assert.ok(existsSync(scriptPath), `fixture script missing: ${scriptPath}`);

      const result = spawnSync(
        process.execPath,
        [...nodeOptions, scriptPath, ...args(fixtureDirectory)],
        { encoding: "utf8", input: stdin, env: { ...process.env, ...env } },
      );

      assert.notEqual(
        result.status,
        0,
        `${relativePath} exited 0 through a spaced/symlinked path — the entry guard did not fire, ` +
          "so the CLI silently did nothing",
      );
      const diagnostic =
        `${withoutInterpreterWarnings(result.stdout)}\n${withoutInterpreterWarnings(
          result.stderr,
        )}`.trim();
      assert.notEqual(
        diagnostic,
        "",
        `${relativePath} produced no diagnostic — a silent no-op is exactly the guard failure`,
      );
    });
  });
}

// Directories that hold no first-party CLI source. `__tests__` is excluded
// because a test file legitimately references both markers while spawning the
// scripts under test — including it would make this check flag itself.
const SKIPPED_DIRECTORY_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
  ".turbo",
  ".worktrees",
  "__tests__",
]);
const SOURCE_EXTENSIONS = /\.(mjs|cjs|js|ts|mts|cts|tsx)$/;

function collectSourceFiles(directory, collected) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;
      collectSourceFiles(join(directory, entry.name), collected);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.test(entry.name)) {
      collected.push(join(directory, entry.name));
    }
  }
  return collected;
}

// Negative control on the scan, expressed PER ROOT. One global threshold is
// carried by whichever root is largest, and here that is `packages/` (~118
// files) which holds ZERO guarded CLIs — so losing `tools/` outright, 4 of the 9
// guards including `pre-commit-runner.ts`, still left ~156 files and sailed past
// a `> 100` global check. The floor was guarding the root that mattered least.
//
// Each floor sits well below today's count so routine deletions do not trip it,
// and far enough above zero that a root which stops resolving does.
const SEARCH_ROOT_FLOORS = { tools: 8, ".claude": 8, packages: 50, apps: 10 };

test("the list is complete — every guarded CLI in the tree is spawned above", () => {
  const candidates = [];
  for (const [rootName, floor] of Object.entries(SEARCH_ROOT_FLOORS)) {
    const rootPath = join(REPO_ROOT, rootName);
    // Assert, never filter. `.filter(existsSync)` silently shrank the scan when
    // a root was renamed, which is the same false clean the floors exist to
    // catch — a smaller walk that still reports complete.
    assert.ok(
      existsSync(rootPath),
      `search root ${rootName}/ does not exist — it was renamed or removed. Update ` +
        "SEARCH_ROOT_FLOORS deliberately; dropping it silently would narrow this scan while " +
        "it still claims to cover the tree",
    );
    const found = collectSourceFiles(rootPath, []);
    assert.ok(
      found.length >= floor,
      `source scan found only ${found.length} file(s) under ${rootName}/ (floor ${floor}) — ` +
        "the walk is broken for that root, so a clean result here would prove nothing",
    );
    candidates.push(...found);
  }

  // The signal for "this script discriminates imported-vs-invoked" is that it
  // consults BOTH its own module URL and the path it was invoked as. The
  // invoked-path half is matched as bare `process.argv`, NOT `process.argv[1]`:
  // keying on the subscripted spelling made the signal idiom-dependent in the
  // exact way the comment here used to deny, since `const argv = process.argv`,
  // a destructure, or `process.argv.at(1)` all evade it while guarding the same
  // thing. Over-inclusion is the deliberate trade — a file that consults both
  // for unrelated reasons is caught and simply joins the fixture list, where it
  // gets the same does-it-actually-run assertion. There is deliberately NO
  // exemption channel: an exemption can only be validated by a proxy for
  // "carries no guard", and a proxy that drifts produces exactly the false
  // clean this file exists to prevent.
  const guardedPaths = candidates
    .filter((absolutePath) => {
      const source = readFileSync(absolutePath, "utf8");
      // `import.meta.main` (Node 24) IS the whole guard — it takes no
      // invoked-path operand — so it cannot be expressed as half of a pair.
      if (/import\.meta\.main/.test(source)) return true;
      // Both operands are matched as families rather than as one spelling each.
      // Fixing only the argv side (round 4) left the self-reference side just as
      // narrow: `import.meta.filename` is the more modern spelling and carries no
      // `import.meta.url`, so a guard written with it would have been invisible
      // for exactly the reason the original `.mjs` glob was.
      const selfReference = /import\.meta\.(url|filename)/.test(source);
      return selfReference && /process\.argv/.test(source);
    })
    .map((absolutePath) => relative(REPO_ROOT, absolutePath).split(sep).join("/"))
    .sort();

  const listedPaths = CLI_SCRIPTS.map((entry) => entry.relativePath).sort();

  const unlisted = guardedPaths.filter((path) => !listedPaths.includes(path));
  assert.deepEqual(
    unlisted,
    [],
    "guarded CLI(s) missing from CLI_SCRIPTS — add each to the fixture list with arguments " +
      "that make a RUNNING script exit non-zero, otherwise this suite reports clean over a " +
      `script it never spawns:\n  ${unlisted.join("\n  ")}`,
  );

  // The converse: an entry naming a script that no longer carries a guard is a
  // test that can no longer fail for the reason it claims to.
  const stale = listedPaths.filter((path) => !guardedPaths.includes(path));
  assert.deepEqual(
    stale,
    [],
    `CLI_SCRIPTS names script(s) that no longer carry an entry guard:\n  ${stale.join("\n  ")}`,
  );
});
