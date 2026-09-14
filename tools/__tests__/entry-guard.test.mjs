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
// KEEPING THE LIST HONEST
// -----------------------
// The list is maintained by hand, so a CLI nobody adds is simply never spawned
// and this suite reports clean over a script it did not run. Add every new CLI
// that discriminates invoked-from-imported here, with the arguments that make a
// RUNNING script exit non-zero and say something.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync, unlinkSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// A marked table whose column does not sum to its declared Total. Chosen
// because the violation is entirely WITHIN the file: the gate reaches a
// non-zero verdict without resolving any repo-relative path, so it behaves
// identically whether the script is reached through the real root or through
// the spaced symlink. A fixture that cited a real doc would make the assertion
// depend on how each script resolves the repo, which is not what is under test.
// A window factory whose locked `webPreferences` block has drifted on two keys
// and omits three more. Like the fixture above, the violation is entirely
// WITHIN the file, so the verdict does not depend on how the script resolves
// the repo — which is the point, since this script resolves its DEFAULT target
// through `import.meta.url` and the spaced symlink is exactly what breaks that.
const DRIFTED_WINDOW_FIXTURE = [
  "new BrowserWindow({",
  "  webPreferences: {",
  "    contextIsolation: true,",
  "    sandbox: false,",
  "    nodeIntegration: true,",
  "  },",
  "});",
  "",
].join("\n");

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
  { relativePath: ".claude/skills/plan-execution/scripts/preflight.mjs", args: () => [] },
  { relativePath: ".claude/skills/plan-execution/scripts/codex-gate.mjs", args: () => [] },
  {
    relativePath: "apps/desktop/build/assert-webprefs.ts",
    nodeOptions: ["--experimental-strip-types"],
    args: (fixtureDirectory) => [join(fixtureDirectory, "drifted-window.ts")],
  },
  {
    relativePath: "apps/desktop/scripts/budget/measure-bundle.mts",
    nodeOptions: ["--experimental-strip-types"],
    args: () => ["--no-such-flag"],
  },
  {
    relativePath: "apps/desktop/scripts/budget/measure-heap.mts",
    nodeOptions: ["--experimental-strip-types"],
    args: () => ["--no-such-flag"],
  },
  { relativePath: "tools/lefthook-worktree-lock.mjs", args: () => ["no-such-command"] },
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
  writeFileSync(join(containingDirectory, "drifted-window.ts"), DRIFTED_WINDOW_FIXTURE);
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
