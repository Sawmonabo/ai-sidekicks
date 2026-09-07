// `test:changed`, with the base ref where `--changed` can actually see it.
//
// THE BUG THIS EXISTS TO REMOVE
// -----------------------------
// The script line was `vitest run --project=console-unit --changed --maxWorkers=2`,
// and a lane ran it as `pnpm run test:changed <base-ref>`. pnpm APPENDS the
// caller's arguments, so the ref landed after `--maxWorkers=2` — and `--changed`
// takes an OPTIONAL argument, which `--maxWorkers=2` had already terminated. The
// ref therefore arrived as a positional FILE FILTER. A branch name matches no
// test file, so vitest selected nothing, and selecting nothing is not an error:
// the run exited 0 and the lane read a green result as "my changes are covered".
// A verification step that cannot fail is worse than one that is missing, because
// somebody is relying on it.
//
// So the ref is this script's FIRST ARGUMENT, and it is attached to `--changed`
// with `=` rather than left beside it — the `=` form admits no question about
// where the option's argument ends, which is the exact ambiguity above. Anything
// the caller passes after the ref is forwarded to vitest untouched.
//
// A CALL WITH NO REF REFUSES
// --------------------------
// The two things it could do instead are both wrong. Falling back to bare
// `--changed` compares against the working tree's uncommitted state, which on a
// committed branch is empty — the silent zero-test run again, one layer down.
// Running the whole tier ignores what the caller asked for and buries the
// mistake under a green wall. The refusal exits `MISUSE_EXIT_CODE`, which is
// distinct from the `1` vitest itself exits with on a failing test, so a caller
// can tell "you invoked me wrongly" from "your tests failed".
//
// AND A REF THAT DOES NOT RESOLVE REFUSES FOR THE SAME REASON
// -----------------------------------------------------------
// A NONEMPTY ref passes the check above and can still name nothing — a typo, a
// remote branch that was deleted, a `origin/develop` on a clone that has never
// fetched. `--changed=<unknown>` is not an error to vitest: it resolves no
// revision, selects no file, prints "No test files found" and EXITS 0. That is
// byte for byte the false green the argument-position bug produced, arriving
// through the other door — and it is the likelier of the two now that the
// position is fixed, because a stale ref is an ordinary thing for a lane to
// hold. So the ref is resolved here, before vitest is spawned, and a ref that
// names no commit is a misuse rather than a passing run. It is resolved to a
// COMMIT (`<ref>^{commit}`) rather than merely dereferenced, because a name that
// resolves to a tree or a blob is a name `--changed` cannot diff either.
//
// NO `import.meta` ANYWHERE, DELIBERATELY
// ---------------------------------------
// `tools/__tests__/entry-guard.test.mjs` derives its subject set as the scripts
// that read BOTH `import.meta.url` and `process.argv` — the pair that means a
// module discriminates "imported" from "invoked". This one reads argv and never
// its own path, so it is outside that set by the classifier's own definition
// rather than by an exemption, and it needs no entry guard: it exports nothing,
// nothing imports it, and its own test spawns it as a command. Module resolution
// therefore anchors on the package root, which is where a package script's cwd
// already is — the seam `scripts/materialize-electron.ts` measures and records.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

const LOG_PREFIX = "[test-changed]";

const USAGE =
  "usage: pnpm --filter @ai-sidekicks/desktop run test:changed <base-ref> [vitest args...]";

/**
 * What a misuse exits with, chosen so it is not what a test failure exits with.
 *
 * vitest exits `1` when a test fails and `0` when none does. A refusal that
 * exited `1` would be indistinguishable from a red suite in CI output, and one
 * that exited `0` would be the silent success this script was written to end.
 */
const MISUSE_EXIT_CODE = 2;

/** The tier this script runs. One project, because one lane's changes are unit-scoped. */
const CHANGED_TIER_PROJECT = "console-unit";

/** Held here rather than in the script line, which is what the caller appends to. */
const CHANGED_TIER_WORKERS = "2";

/**
 * The vitest CLI entry point, resolved rather than shelled to.
 *
 * `node_modules/.bin/vitest` is a shim — a shell script on POSIX and a `.CMD`
 * on Windows — so spawning it by name makes the call platform-shaped. The
 * package's `bin` field names the real module, and running it under
 * `process.execPath` is the same form `scripts/materialize-electron.ts` uses to
 * run Electron's own `install.js`.
 */
function resolveVitestEntryPoint(packageRoot: string): string {
  const resolveFrom = createRequire(path.join(packageRoot, "package.json"));
  const manifestPath = resolveFrom.resolve("vitest/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    readonly bin?: Readonly<Record<string, string>>;
  };
  const entryPoint = manifest.bin?.["vitest"];
  if (entryPoint === undefined) {
    process.stderr.write(`${LOG_PREFIX} vitest publishes no \`bin.vitest\` at ${manifestPath}.\n`);
    process.exit(MISUSE_EXIT_CODE);
  }
  return path.resolve(path.dirname(manifestPath), entryPoint);
}

/**
 * Refuse unless `baseRef` names a commit this repository can actually diff.
 *
 * `git rev-parse --verify --quiet <ref>^{commit}` is the whole check: `--verify`
 * demands exactly one object, the `^{commit}` peel demands that object be a
 * commit, and `--quiet` keeps git's own diagnostic off a stream this script's
 * caller reads as this script's voice. Both of git's streams are captured for
 * the same reason — a refusal must be THIS script speaking, and a run that
 * succeeds must leave stderr empty.
 *
 * A git that could not run at all is reported separately from a ref that did not
 * resolve. They are different repairs — install or fix the toolchain, versus
 * pass a ref that exists — and collapsing them would send a reader looking for a
 * branch that was never the problem.
 */
function refuseUnlessBaseRefResolves(baseRef: string, packageRoot: string): void {
  const resolved = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], {
    cwd: packageRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (resolved.error !== undefined) {
    process.stderr.write(
      `${LOG_PREFIX} could not resolve \`${baseRef}\`: git did not run (${resolved.error.message}).\n`,
    );
    process.exit(MISUSE_EXIT_CODE);
  }
  if (resolved.status !== 0) {
    process.stderr.write(
      `${LOG_PREFIX} base ref \`${baseRef}\` resolves to no commit in this repository. ` +
        `\`--changed\` would select no file and vitest would exit 0, reporting a run that ` +
        `never happened as a passing one.\n${USAGE}\n`,
    );
    process.exit(MISUSE_EXIT_CODE);
  }
}

function runChangedTier(): void {
  const [baseRef, ...forwarded] = process.argv.slice(2);
  if (baseRef === undefined || baseRef === "") {
    process.stderr.write(
      `${LOG_PREFIX} no base ref. \`--changed\` needs the ref to compare against, and a ` +
        `run without one either compares against nothing or runs everything.\n${USAGE}\n`,
    );
    process.exit(MISUSE_EXIT_CODE);
  }

  const packageRoot = process.cwd();
  // Before the vitest entry point is even resolved: this refusal is about the
  // caller's argument, and a run that reports "vitest publishes no bin" over a
  // ref that never existed has named the wrong repair.
  refuseUnlessBaseRefResolves(baseRef, packageRoot);
  const result = spawnSync(
    process.execPath,
    [
      resolveVitestEntryPoint(packageRoot),
      "run",
      `--project=${CHANGED_TIER_PROJECT}`,
      `--changed=${baseRef}`,
      `--maxWorkers=${CHANGED_TIER_WORKERS}`,
      ...forwarded,
    ],
    { stdio: "inherit", cwd: packageRoot },
  );

  if (result.error !== undefined) {
    process.stderr.write(`${LOG_PREFIX} could not run vitest: ${result.error.message}\n`);
    process.exit(1);
  }
  // A signalled run reports a null status, and exiting 0 on it would report a
  // killed suite as a passing one — the same false success as the defect above.
  if (result.status === null) {
    process.stderr.write(`${LOG_PREFIX} vitest was terminated by ${String(result.signal)}.\n`);
    process.exit(1);
  }
  process.exit(result.status);
}

runChangedTier();
