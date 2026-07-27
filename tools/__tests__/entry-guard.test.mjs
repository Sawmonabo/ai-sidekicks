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

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync, unlinkSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Each entry is invoked with arguments guaranteed to make a RUNNING script exit
// non-zero with a diagnostic. That turns "did the guard fire?" into an
// observable: guard fires => non-zero + stderr; guard no-ops => 0 + silence.
const CLI_SCRIPTS = [
  { relativePath: "tools/run-node-tests.mjs", args: ["no/such/**/*.test.mjs"] },
  { relativePath: ".claude/skills/plan-execution/scripts/post-merge-housekeeper.mjs", args: [] },
  { relativePath: ".claude/skills/plan-execution/scripts/rebuild-shipment-manifest.mjs", args: [] },
  { relativePath: ".claude/skills/plan-execution/scripts/validate-review-response.mjs", args: [] },
];

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
  try {
    return runBody(spacedRepoLink);
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

for (const { relativePath, args } of CLI_SCRIPTS) {
  test(`${relativePath}: entry guard fires through a spaced, symlinked path`, () => {
    withSpacedSymlinkedRepo((spacedRepoLink) => {
      const scriptPath = join(spacedRepoLink, relativePath);
      assert.ok(existsSync(scriptPath), `fixture script missing: ${scriptPath}`);

      const result = spawnSync(process.execPath, [scriptPath, ...args], { encoding: "utf8" });

      assert.notEqual(
        result.status,
        0,
        `${relativePath} exited 0 through a spaced/symlinked path — the entry guard did not fire, ` +
          "so the CLI silently did nothing",
      );
      assert.notEqual(
        result.stderr.trim(),
        "",
        `${relativePath} produced no diagnostic — a silent no-op is exactly the guard failure`,
      );
    });
  });
}
