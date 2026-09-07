// The guard on `test:changed`, driven as a command.
//
// SPAWNED, NEVER IMPORTED. The rule under test is what the script does when it
// is INVOKED with the wrong arguments: it reads `process.argv`, writes to
// `process.stderr`, and calls `process.exit`. Importing the module and calling a
// function would test a function, exercise none of those three, and leave the
// only thing a caller ever touches — the process's exit code — unasserted.
//
// The refusal matters because a wrong invocation of this script is SILENT. Both
// halves were measured, not reasoned about: with the ref appended after
// `--maxWorkers=2` it arrived as a positional file filter and vitest reported
// "No test files found, exiting with code 0"; and with the ref attached to
// `--changed` but naming no revision, vitest reports the same thing and exits 0
// again. A verification step whose two commonest misuses both exit 0 is a step
// that cannot fail, so the refusal is the only place the mistake can surface.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, "..");
const SCRIPT = path.join(HERE, "test-changed.ts");

/** The exit code the script reserves for a misuse, distinct from vitest's `1`. */
const MISUSE_EXIT_CODE = 2;

/**
 * Keeps the INTERPRETER off the stream this suite reads as the script's voice.
 *
 * `--experimental-strip-types` makes Node print `ExperimentalWarning: Type
 * Stripping …` plus its `--trace-warnings` follow-up to stderr before the script
 * body runs. Measured on Node 22.12 (the same two lines the CI job prints for
 * every other type-stripped script it invokes): without this flag the run below
 * that asserts an EMPTY stderr fails on the interpreter's chatter, so the
 * assertion is passing today by interpreter-version accident rather than by
 * design.
 *
 * Suppressed AT THE SOURCE rather than filtered out of the captured text, and the
 * choice is the point. A filter over `(node:NNN)` lines — which
 * `tools/__tests__/entry-guard.test.mjs` uses, because it spawns a dozen scripts
 * it does not own under flags it does not choose — also swallows a warning the
 * script itself caused, which is exactly the content-blindness a stderr assertion
 * exists to avoid. This suite owns its single spawn, so it can name the one
 * warning class it did not ask for and leave the assertion byte-exact: anything
 * on stderr after this is the script speaking.
 *
 * That helper is NOT reused here, and not for want of trying — it cannot be
 * imported from this file and both routes refuse mechanically. As `.mjs` it is
 * TS7016 (no declaration) and `allowJs` is TS5053 against the repo-wide
 * `isolatedDeclarations`; as `.mts` it is TS6059, outside `tsconfig.scripts.json`'s
 * `rootDir`. Widening either to share four lines of string handling would put the
 * repository's tooling tree inside the config that type-validates this package's
 * scripts.
 */
const SUPPRESS_INTERPRETER_WARNING = "--disable-warning=ExperimentalWarning";

/**
 * Run the script the way a package script runs it.
 *
 * `cwd` is the package root because that is where pnpm puts a package script,
 * and the script resolves vitest from there. Passing it explicitly means this
 * suite's own working directory — whatever the runner chose — cannot decide
 * whether the resolution succeeds.
 */
function runScript(...args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    [SUPPRESS_INTERPRETER_WARNING, "--experimental-strip-types", SCRIPT, ...args],
    {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
    },
  );
}

describe("test:changed refuses an invocation with no base ref", () => {
  it("exits with the misuse code and names what is missing", () => {
    const refused = runScript();

    expect(refused.status).toBe(MISUSE_EXIT_CODE);
    expect(refused.stderr).toContain("no base ref");
    expect(refused.stderr).toContain("test:changed <base-ref>");
    // Nothing was run. A refusal that had already started vitest would leave the
    // caller reading a partial run's output beside a message telling them the
    // run never happened.
    expect(refused.stdout).toBe("");
  });

  it("runs vitest once it has one, so the refusal is about the ref", () => {
    // The non-vacuity control. Without it, a script that was simply broken — a
    // bad resolve, a syntax error, an unconditional refusal — would satisfy the
    // case above and satisfy it for the wrong reason. `--help` is carried
    // through as a forwarded argument and vitest answers it before loading a
    // config or running a test, so this costs a tenth of a second and still
    // proves the whole path: argument accepted, vitest resolved, spawned, its
    // exit code returned, and the caller's own arguments passed on.
    const helped = runScript("origin/develop", "--help");

    expect(helped.status).toBe(0);
    expect(helped.stdout).toContain("vitest run");
    expect(helped.stderr).toBe("");
  });
});
