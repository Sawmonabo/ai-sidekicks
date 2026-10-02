// Every repo CLI that tells "imported" from "invoked as a command" must still run when reached
// through a symlinked directory whose name contains a space. Comparing `import.meta.url` to
// `file://` plus `process.argv[1]` matches an encoded URL against a raw path, so a space (or `#`,
// `?`, non-ASCII) or a symlink such as macOS `/tmp` keeps the guard from firing: the CLI does
// nothing and exits 0. Each script is spawned here with arguments that make a running script exit
// non-zero with a diagnostic, so a no-op shows up as exit 0 and silence.
//
// The list is maintained by hand: add every new CLI that has such a guard.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync, unlinkSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// `args` makes a running script fail with a diagnostic. `nodeOptions` are the flags a script needs
// to load; the TypeScript CLIs run from source, as CI and lefthook do.
const CLI_SCRIPTS = [
  { relativePath: "tools/run-node-tests.mjs", args: () => ["no/such/**/*.test.mjs"] },
  { relativePath: ".claude/skills/plan-execution/scripts/preflight.mjs", args: () => [] },
  { relativePath: ".claude/skills/plan-execution/scripts/codex-gate.mjs", args: () => [] },
  {
    relativePath: "apps/desktop/scripts/budget/measure-bundle.mts",
    nodeOptions: ["--experimental-strip-types"],
    args: () => ["--no-such-flag"],
  },
  { relativePath: "tools/lefthook-worktree-lock.mjs", args: () => ["no-such-command"] },
];

// Node warns on stderr for `--experimental-strip-types` even when the script body never runs, so
// its own chatter is removed before checking that the script spoke.
function withoutInterpreterWarnings(streamText) {
  return (streamText ?? "")
    .split("\n")
    .filter((line) => !/^\(node:\d+\)/.test(line) && !/^\(Use `node --trace-warnings/.test(line))
    .join("\n")
    .trim();
}

/** Runs `runBody` with the repo symlinked under a directory name containing a space. */
function withSpacedSymlinkedRepo(runBody) {
  const containingDirectory = mkdtempSync(join(tmpdir(), "entry-guard-"));
  const spacedRepoLink = join(containingDirectory, "repo root with spaces");
  symlinkSync(REPO_ROOT, spacedRepoLink, "dir");
  try {
    return runBody(spacedRepoLink);
  } finally {
    // Unlink first so the recursive delete below never walks a link into the working repo.
    unlinkSync(spacedRepoLink);
    rmSync(containingDirectory, { recursive: true, force: true });
  }
}

for (const { relativePath, args, nodeOptions = [], stdin = "", env } of CLI_SCRIPTS) {
  test(`${relativePath}: does not silently no-op through a spaced, symlinked path`, () => {
    withSpacedSymlinkedRepo((spacedRepoLink) => {
      const scriptPath = join(spacedRepoLink, relativePath);
      assert.ok(existsSync(scriptPath), `script missing: ${scriptPath}`);

      const result = spawnSync(process.execPath, [...nodeOptions, scriptPath, ...args()], {
        encoding: "utf8",
        input: stdin,
        env: { ...process.env, ...env },
      });

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
