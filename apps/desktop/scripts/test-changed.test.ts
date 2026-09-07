// The guard on `test:changed`, driven as a command.
//
// SPAWNED, NEVER IMPORTED. The rule under test is what the script does when it
// is INVOKED with the wrong arguments: it reads `process.argv`, writes to
// `process.stderr`, and calls `process.exit`. Importing the module and calling a
// function would test a function, exercise none of those three, and leave the
// only thing a caller ever touches — the process's exit code — unasserted.
//
// The SELECTION is driven the same way and for the same reason. A lane forwards
// the files it authored, and the fixed `--project=console-unit` this script used
// to pass could not run a `main-unit` file — so a real test file, named
// explicitly on the command line, matched in no selected project and the run
// exited 0. Asserting the exit code alone cannot see that: an empty selection
// under `--changed` exits 0 exactly as a passing one does. So the case below
// asserts that the forwarded file's own NAME appears in what vitest reported,
// which is the only reading that separates "it ran" from "it was skipped".
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

/**
 * The commit this checkout certainly holds, resolved the way the script will.
 *
 * A REMOTE-TRACKING NAME IS THE WRONG INSTRUMENT, and replacing one is what this
 * exists for. The successful-path control used to pass `origin/develop`, which a
 * full clone has and a fresh one does not: `actions/checkout@v5` is configured
 * here with no `fetch-depth`, so it fetches one ref at depth 1 and the job that
 * runs this project holds no `origin/develop` at all. The script's own ref guard
 * therefore refused before vitest was ever reached, and a case whose whole
 * subject is the SUCCESSFUL path asserted `0` against the misuse code on every
 * CI run. A ref the environment happens to carry is a precondition this suite
 * does not control; the commit `HEAD` names is one it does, in a shallow clone
 * and a full one alike — so the control asserts that the guard ADMITS A REF THAT
 * RESOLVES rather than one somebody remembered to fetch.
 *
 * Resolved with the same `^{commit}` peel, in the same working directory the
 * script resolves from, so what is handed over is the object that guard will
 * look for in the repository it will look in. A checkout with no HEAD commit
 * fails HERE with that sentence rather than downstream: it would otherwise turn
 * this control into the refusal case it is the foil for, and pass.
 */
function checkoutLocalCommit(): string {
  const resolved = spawnSync("git", ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
  });

  expect(
    resolved.status,
    "this checkout resolves no HEAD commit, so there is no ref the successful-path control can prove the guard admits",
  ).toBe(0);
  return resolved.stdout.trim();
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
    const helped = runScript(checkoutLocalCommit(), "--help");

    expect(helped.status).toBe(0);
    expect(helped.stdout).toContain("vitest run");
    expect(helped.stderr).toBe("");
  });
});

describe("test:changed refuses a base ref that resolves to no commit", () => {
  /**
   * A ref no repository holds, and deliberately not a plausible one.
   *
   * A branch name a clone MIGHT have would make this case pass or fail on the
   * checkout it happens to run in, which is the opposite of what a guard against
   * a stale ref should be measured by.
   */
  const UNRESOLVABLE_REF = "no-such-ref/test-changed-guard";

  it("exits with the misuse code and names the ref it could not resolve", () => {
    // THE SECOND SILENT-GREEN DOOR. The empty-ref guard above passes a NONEMPTY
    // ref straight through, and `--changed=<unknown>` is not an error to vitest:
    // it resolves no revision, selects no file, reports "No test files found" and
    // exits 0. A lane holding a typo or a deleted remote branch therefore read a
    // green result as "my changes are covered" — byte for byte the false success
    // the argument-position fix removed, arriving through the other door.
    const refused = runScript(UNRESOLVABLE_REF);

    expect(refused.status).toBe(MISUSE_EXIT_CODE);
    expect(refused.stderr).toContain(UNRESOLVABLE_REF);
    expect(refused.stderr).toContain("resolves to no commit");
    // Nothing was run, and git said nothing of its own. The resolution captures
    // both of git's streams, so a reader's whole picture of this failure is the
    // sentence this script wrote — and a refusal that had already started vitest
    // would leave partial run output above a message saying it never ran.
    expect(refused.stdout).toBe("");
  });

  it("refuses a ref that names an object which is not a commit", () => {
    // The `^{commit}` peel, driven rather than described. `HEAD^{tree}` resolves
    // to a real object in every repository this can run in, and `--changed` can
    // diff none of them — so a guard that only asked "does this name resolve"
    // would admit it and hand vitest a revision it silently selects nothing for.
    const refused = runScript("HEAD^{tree}");

    expect(refused.status).toBe(MISUSE_EXIT_CODE);
    expect(refused.stderr).toContain("resolves to no commit");
    expect(refused.stdout).toBe("");
  });
});

describe("test:changed runs the project that owns each forwarded file", () => {
  /**
   * A real `main-unit` test file, which the superseded selection could not run.
   *
   * `src/shared/**` is owned by `main-unit`, and `main-unit` is exactly the
   * project the fixed `--project=console-unit` excluded — so this file is the
   * finding rather than an example of it. Small and dependency-free, so the case
   * costs one short suite rather than a tier.
   */
  const MAIN_UNIT_FILE = "src/shared/wire-errors.test.ts";

  /** A real file owned by a tier this command deliberately does not run. */
  const ELECTRON_TIER_FILE = "test/console/e2e/frame-boot.test.ts";

  it("selects `main-unit` for a `main-unit` file and actually runs it", () => {
    const ran = runScript(checkoutLocalCommit(), MAIN_UNIT_FILE);

    expect(ran.status).toBe(0);
    // THE FINDING. Under the superseded selection this file was named on the
    // command line, matched in no selected project, and the command reported a
    // successful unit verification having executed nothing.
    // Vitest's default reporter names no path on a clean run, so the reading
    // that separates "it ran" from "it was skipped" is the FILE COUNT: exactly
    // one, against the `No test files found` an empty selection reports.
    expect(
      ran.stdout,
      "the forwarded file was not run — the selection excludes the project that owns it",
    ).toMatch(/Test Files\s+1 passed/);
  }, 120_000);

  it("refuses a file no unit project claims rather than skipping it", () => {
    // The other half: this command runs the projects that need no prior build,
    // and a file belonging to one of the others must not be quietly dropped into
    // an empty selection that exits 0.
    const refused = runScript(checkoutLocalCommit(), ELECTRON_TIER_FILE);

    expect(refused.status).toBe(MISUSE_EXIT_CODE);
    expect(refused.stderr).toContain(ELECTRON_TIER_FILE);
    expect(refused.stderr).toContain("claimed by none of");
  }, 120_000);
});
