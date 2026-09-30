// Drives `test-changed.ts` as a command and never imports it: the rule under test is what it does
// when invoked with wrong arguments (read `process.argv`, write stderr, exit), and the exit code is
// all a caller touches. Both silent misuses were measured: a ref appended after `--maxWorkers=2`
// and a ref naming no revision each make vitest report "No test files found" and exit 0. An empty
// selection exits 0 exactly as a passing run does, so the selection cases assert vitest's file
// count line instead of the exit code alone. Streams are read through one stripper with color off,
// because a colorizing runner puts escapes between the words of the summary line.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, "..");
const SCRIPT = path.join(HERE, "test-changed.ts");

/** The exit code the script reserves for a misuse, distinct from vitest's `1`. */
const MISUSE_EXIT_CODE = 2;

/**
 * Keeps Node's `ExperimentalWarning` for `--experimental-strip-types` off the stderr this suite
 * reads as the script's voice; measured on Node 22.12, the empty-stderr assertion fails without
 * it. It is suppressed at the source rather than filtered from the captured text, because a
 * filter would also swallow a warning the script itself caused. The filter in
 * `tools/__tests__/entry-guard.test.mjs` cannot be imported here: as `.mjs` it fails TS7016 and
 * TS5053, and as `.mts` it is outside `tsconfig.scripts.json`'s `rootDir`.
 */
const SUPPRESS_INTERPRETER_WARNING = "--disable-warning=ExperimentalWarning";

/**
 * Runs the script the way a package script runs it. `cwd` is the package root, where pnpm runs it
 * and where it resolves vitest, so this suite's own working directory cannot decide the outcome.
 */
function runScript(...args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    [SUPPRESS_INTERPRETER_WARNING, "--experimental-strip-types", SCRIPT, ...args],
    {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
      env: colorFreeEnvironment(),
    },
  );
}

/**
 * The child's environment with color off. `NO_COLOR` rather than `FORCE_COLOR=0`: vitest's color
 * library tests `"FORCE_COLOR" in env` and `picocolors` tests `!!env.FORCE_COLOR`, so `"0"` turns
 * color on in both. The inherited variable is deleted for the same reason. Only the child's
 * environment changes.
 */
function colorFreeEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  delete environment["FORCE_COLOR"];
  return environment;
}

/**
 * The child's stdout with terminal control sequences removed; every assertion on what the command
 * reported reads through it. A colorizing runner puts escapes between the words of the summary
 * line (CI emitted `Test Files \u001B[22m \u001B[1m\u001B[32m1 passed`), which `\s+` cannot
 * match, while a piped child on a developer's machine stays uncolored. It uses `node:util`'s
 * stripper rather than a pattern of ours.
 */
function plainStdout(result: SpawnSyncReturns<string>): string {
  return stripVTControlCharacters(result.stdout);
}

/** The child's stderr, read the same way and for the same reason. */
function plainStderr(result: SpawnSyncReturns<string>): string {
  return stripVTControlCharacters(result.stderr);
}

/**
 * The commit this checkout certainly holds, resolved the way the script will. A remote-tracking
 * name is the wrong instrument: a shallow CI checkout may hold no `origin/develop`, so the script's
 * ref guard would refuse before vitest ran and the successful-path control would see the misuse
 * code. `HEAD` exists in a shallow and a full clone alike. A checkout with no HEAD commit fails
 * here rather than passing as the refusal case.
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
    expect(plainStderr(refused)).toContain("no base ref");
    expect(plainStderr(refused)).toContain("test:changed <base-ref>");
    // Nothing was run: a refusal after vitest had started would leave partial output beside a
    // message saying it never ran.
    expect(plainStdout(refused)).toBe("");
  });

  it("runs vitest once it has one, so the refusal is about the ref", () => {
    // The non-vacuity control: a broken script (bad resolve, syntax error, unconditional refusal)
    // would satisfy the case above for the wrong reason. Vitest answers `--help` before loading a
    // config, so this cheaply proves argument acceptance, vitest resolution, the spawn, the exit
    // code and the forwarding of the caller's arguments.
    const helped = runScript(checkoutLocalCommit(), "--help");

    expect(helped.status).toBe(0);
    expect(plainStdout(helped)).toContain("vitest run");
    expect(plainStderr(helped)).toBe("");
  });
});

describe("test:changed refuses a base ref that resolves to no commit", () => {
  /**
   * A ref no repository holds, deliberately not a plausible branch name, so the outcome does not
   * depend on the checkout the case runs in.
   */
  const UNRESOLVABLE_REF = "no-such-ref/test-changed-guard";

  it("exits with the misuse code and names the ref it could not resolve", () => {
    // A nonempty ref passes the empty-ref guard, and `--changed=<unknown>` is not an error to
    // vitest: it selects no file, reports "No test files found" and exits 0.
    const refused = runScript(UNRESOLVABLE_REF);

    expect(refused.status).toBe(MISUSE_EXIT_CODE);
    expect(plainStderr(refused)).toContain(UNRESOLVABLE_REF);
    expect(plainStderr(refused)).toContain("resolves to no commit");
    // Nothing was run and git said nothing of its own: both of git's streams are captured, so the
    // only message is this script's.
    expect(plainStdout(refused)).toBe("");
  });

  it("refuses a ref that names an object which is not a commit", () => {
    // Drives the `^{commit}` peel: `HEAD^{tree}` resolves to a real object everywhere, but
    // `--changed` cannot diff a tree, so a guard that only asked whether the name resolves would
    // admit it.
    const refused = runScript("HEAD^{tree}");

    expect(refused.status).toBe(MISUSE_EXIT_CODE);
    expect(plainStderr(refused)).toContain("resolves to no commit");
    expect(plainStdout(refused)).toBe("");
  });
});

describe("test:changed runs the project that owns each forwarded file", () => {
  /**
   * A real `main-unit` test file, a project a selection fixed to `renderer` could not run.
   * Small and dependency-free, so the case costs one short suite rather than a tier.
   */
  const MAIN_UNIT_FILE = "src/main/services/missing-path.test.ts";

  /**
   * Vitest's own count line, the reading that says the file ran. It is named once so the control
   * below holds the same pattern against a colorized sample.
   */
  const TEST_FILE_COUNT = /Test Files\s+1 passed/;

  /** A real file owned by a tier this command deliberately does not run. */
  const ELECTRON_TIER_FILE = "tests/e2e/window-came-up-blank.test.ts";

  /**
   * The usage line of vitest's help, counted: `toContain` cannot tell one copy of the help from
   * two, and asking vitest's parser about a help request prints a second copy.
   */
  const VITEST_RUN_USAGE_LINE = "$ vitest run";

  it("negative control: the colorized summary this pattern must survive", () => {
    // Bytes GitHub Actions produced: the reporter puts escapes between the words, so `\s+` meets
    // `\u001B[22m` where it wants a space. The first assertion shows the hazard exists, and the
    // second shows the strip removes it.
    const colorized =
      "\u001B[2m Test Files \u001B[22m \u001B[1m\u001B[32m1 passed\u001B[39m\u001B[22m (1)\n";

    expect(colorized, "the hazard is gone, so this control now proves nothing").not.toMatch(
      TEST_FILE_COUNT,
    );
    expect(stripVTControlCharacters(colorized)).toMatch(TEST_FILE_COUNT);
  });

  it("selects `main-unit` for a `main-unit` file and actually runs it", () => {
    const ran = runScript(checkoutLocalCommit(), MAIN_UNIT_FILE);

    expect(ran.status).toBe(0);
    // The file count separates "it ran" from "it was skipped": vitest's default reporter names no
    // path on a clean run, and an empty selection reports `No test files found`.
    expect(
      plainStdout(ran),
      "the forwarded file was not run — the selection excludes the project that owns it",
    ).toMatch(TEST_FILE_COUNT);
  }, 120_000);

  it("runs the file beside an option written in either documented form", () => {
    // Vitest documents a separate-value and an attached form for value-taking options. A shape
    // rule ("not starting with `-` is a file") read the separate form's operand as a path and
    // refused a valid invocation. The pattern carries a space on purpose (the reported shape) and
    // is `. ` so it matches every test name without copying one; a bare space would be coerced
    // to `0` by vitest's parser.
    const invocations: readonly (readonly string[])[] = [
      ["--testNamePattern", ". ", "--reporter", "verbose", MAIN_UNIT_FILE],
      ["--reporter=verbose", MAIN_UNIT_FILE],
    ];

    for (const invocation of invocations) {
      const ran = runScript(checkoutLocalCommit(), ...invocation);

      expect(ran.status, invocation.join(" ")).toBe(0);
      expect(plainStdout(ran), invocation.join(" ")).toMatch(TEST_FILE_COUNT);
      // And the reporter was forwarded as an option: the default reporter names no path on a
      // clean run, so a path in the output is the verbose reporter.
      expect(plainStdout(ran), invocation.join(" ")).toContain(MAIN_UNIT_FILE);
    }
  }, 240_000);

  it("refuses an argument list vitest's own parser refuses, in its words", () => {
    // The other half of asking vitest: `--silent` takes an optional value and cac rejects the
    // space-separated spelling, so the caller is told which form to write before a run starts.
    const refused = runScript(checkoutLocalCommit(), "--silent", MAIN_UNIT_FILE);

    expect(refused.status).toBe(MISUSE_EXIT_CODE);
    expect(plainStderr(refused)).toContain("cannot read these arguments");
    expect(plainStderr(refused)).toContain("--silent=true");
    expect(plainStdout(refused)).toBe("");
  }, 120_000);

  it("negative control: a help request prints vitest's usage exactly once", () => {
    // Why the script skips a help request instead of asking the parser: it writes the option list
    // to the calling process's stdout, which would print a second copy above the child's. One
    // occurrence passes; two is the defect.
    const helped = runScript(checkoutLocalCommit(), "--help");

    expect(helped.status).toBe(0);
    expect(plainStdout(helped).split(VITEST_RUN_USAGE_LINE).length - 1).toBe(1);
  });

  it("refuses a file no unit project claims rather than skipping it", () => {
    // This command runs only projects that need no prior build; a file from another project must
    // not be dropped into an empty selection that exits 0.
    const refused = runScript(checkoutLocalCommit(), ELECTRON_TIER_FILE);

    expect(refused.status).toBe(MISUSE_EXIT_CODE);
    expect(plainStderr(refused)).toContain(ELECTRON_TIER_FILE);
    expect(plainStderr(refused)).toContain("claimed by none of");
  }, 120_000);
});
