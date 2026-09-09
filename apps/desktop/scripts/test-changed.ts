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
// AND ONE PROJECT COULD NOT RUN THE FILE IT WAS HANDED
// -----------------------------------------------------
// The selection was the literal `--project=console-unit`, and the lane workflow
// this script exists to serve forwards the files the lane AUTHORED after the
// ref. A `main-unit` file — `src/main/**`, `src/shared/**`, `build/**`, and
// this script's own test under `scripts/**` — is owned by a project that
// selection excludes, so vitest was handed a filter naming a real test file,
// matched it in no selected project, and exited 0. The third door onto the same
// false green, and the one a lane walks through while doing exactly what the
// documented workflow tells it to.
//
// The same reading settles what `--changed` may still narrow. It INTERSECTS
// with a positional filter, so a lane that edits a module and forwards that
// module's test — a change and its coverage being two files — names a file the
// ref does not list, and vitest selects the empty intersection and exits 0. So
// the ref decides the selection only when nothing was named; a caller who names
// files has stated it, and the ref is still required and still resolved so a
// stale one is still reported.
//
// AND WHICH ARGUMENTS ARE FILES IS ASKED OF VITEST
// --------------------------------------------------
// Deciding that by shape — "anything not starting with `-` is a file" — reads an
// option's separate-value operand as one. `--testNamePattern "palette opens"`
// and `--reporter verbose` are both documented forms, and both were resolved as
// paths, claimed by no project, and refused with the misuse code: a valid
// invocation this script would not run, which is the opposite failure from the
// three above and just as bad. `vitest/node` exports `parseCLI`, which is the
// parser the child runs, so the answer here and the child's selection cannot
// disagree — and no arity table of ours can go stale against vitest's own.
//
// So the projects are DERIVED from what was forwarded rather than fixed. Which
// project claims a file is a question only the runner can answer — brace
// expansion, whether `**` spans zero segments, how `exclude` composes with
// `include` — so it is asked of the real `TestProject` instances through
// `createVitest`, the same resolution `test/console/architecture/`'s three
// glob questions take. A matcher written here could agree with the config and
// still disagree with the run, which is the class of defect this whole file is
// about.
//
// That resolution is NOT the one in `test/console/vitest-projects.ts`, and
// cannot be: `tsconfig.scripts.json` roots at `scripts/`, so a script importing
// from `test/` is outside the program that typechecks it. What would be shared
// is a four-line `createVitest` call rather than a rule — the RULE is
// `project.matchesTestGlob`, which is vitest's own and is the only matcher
// either side runs.
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

/**
 * The projects a lane's changed-file verification may run, as a closed set.
 *
 * The criterion is one property and not a taste: a project here runs from a
 * clean checkout with no prior `pnpm build`. That is what keeps this script
 * something a lane can invoke at any moment. `console-assets` and
 * `console-bundle` read `out/**`, `main`, `console-e2e` and `console-endurance`
 * launch Electron, and the three browser-mode tiers need a real browser — none
 * of them belongs in a command a lane runs against its own uncommitted work,
 * and a file owned by one of them is REFUSED here rather than silently skipped.
 *
 * The names are held against the resolved project set below, so a project
 * renamed in `vitest.config.ts` fails this script rather than quietly shrinking
 * what it verifies.
 */
const CHANGED_TIER_PROJECTS: readonly string[] = ["renderer", "main-unit", "console-unit"];

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

/**
 * The unit projects that would DISCOVER each forwarded file, asked of the runner.
 *
 * Resolving costs about two hundred milliseconds and runs nothing: the config is
 * loaded and the `TestProject` instances are constructed, no suite is collected
 * and no browser is launched. `vitest/node` is loaded lazily HERE AND IN THE
 * CLASSIFIER ABOVE, and both short-circuit before reaching for it, so the two
 * invocations that need neither — the ordinary `--changed`-only run, which
 * forwards nothing, and the `--help` probe — still pay none of it.
 *
 * A forwarded file no unit project claims is a REFUSAL and never a narrowing.
 * Vitest treats a filter that matches nothing as an empty selection and exits
 * 0, so admitting it would report a run that never happened as a passing one —
 * this script's whole subject, arriving through a third door.
 */
async function unitProjectsClaiming(
  files: readonly string[],
  packageRoot: string,
): Promise<readonly string[]> {
  const { createVitest } = await import("vitest/node");
  const vitest = await createVitest("test", {
    watch: false,
    run: true,
    root: packageRoot,
    config: path.join(packageRoot, "vitest.config.ts"),
  });
  try {
    const unitProjects = vitest.projects.filter((project) =>
      CHANGED_TIER_PROJECTS.includes(project.name),
    );
    if (unitProjects.length !== CHANGED_TIER_PROJECTS.length) {
      const resolved = unitProjects.map((project) => project.name);
      process.stderr.write(
        `${LOG_PREFIX} this package resolves no project named ` +
          `${CHANGED_TIER_PROJECTS.filter((name) => !resolved.includes(name)).join(", ")}. ` +
          `A renamed project would silently shrink what this command verifies.\n`,
      );
      process.exit(MISUSE_EXIT_CODE);
    }
    const selected = new Set<string>();
    for (const file of files) {
      const absolutePath = path.resolve(packageRoot, file);
      const owners = unitProjects.filter((project) => project.matchesTestGlob(absolutePath));
      if (owners.length === 0) {
        process.stderr.write(
          `${LOG_PREFIX} \`${file}\` is claimed by none of ${CHANGED_TIER_PROJECTS.join(", ")}. ` +
            `vitest would select nothing for it and exit 0, reporting a file that never ran ` +
            `as a passing one. Run its own tier directly.\n${USAGE}\n`,
        );
        process.exit(MISUSE_EXIT_CODE);
      }
      for (const owner of owners) {
        selected.add(owner.name);
      }
    }
    return [...selected];
  } finally {
    await vitest.close();
  }
}

/**
 * The two spellings vitest's parser answers by PRINTING rather than by parsing.
 *
 * `--help` and `-h` make cac write the whole option list — measured at 9383
 * bytes on `vitest@4.1.5` — to the CURRENT process's stdout and return an empty
 * filter. Asking it about such an invocation would therefore put a second copy of
 * vitest's help above the child's own, so the classification is skipped: a run
 * that only asks for help selects no file and there is nothing to derive.
 * `--version` is deliberately absent, having been measured to print nothing.
 */
const PARSER_ANSWERS_BY_PRINTING: readonly string[] = ["--help", "-h"];

/**
 * Which forwarded arguments vitest would read as FILE FILTERS, asked of VITEST.
 *
 * NOT A CLASSIFIER OF OUR OWN, and that is the whole of the fix. The rule this
 * replaced was "anything beginning with `-` is an option", which reads an
 * option's SEPARATE-VALUE operand as a file: `--testNamePattern "palette opens"`
 * and `--reporter verbose` are both documented forms, and both handed
 * `unitProjectsClaiming()` a value it resolved as a path, matched to no project,
 * and refused with the misuse code — a valid invocation this script would not
 * run. Any arity table written here would be a second parser holding a copy of
 * vitest's own option list, which is the drift `AGENTS.md §Shared code` forbids
 * and which no test could keep current.
 *
 * `parseCLI` is vitest's parser, exported from `vitest/node`, so what it calls a
 * filter is what the spawned run will select — including the cases where that is
 * surprising. `--update foo.test.ts` yields no filter because `--update` takes an
 * OPTIONAL argument and eats the operand; an unrecognized `--flag value` eats it
 * the same way. Neither is a false green: the file was never going to be a filter
 * in the child either, so the selection this derives and the selection the run
 * performs cannot disagree.
 *
 * A parse REFUSAL is this script's refusal. cac rejects a space-separated value
 * for an optional-argument option (`--silent foo.test.ts`) by throwing, naming
 * the ambiguity and the attached form that resolves it — so the caller is told
 * what to write rather than handed a run that would refuse further downstream.
 *
 * The options this script adds itself cannot perturb the reading: they are all
 * written in the attached `--name=value` form, which terminates its own argument
 * and can consume no operand of the caller's.
 */
async function forwardedFileFilters(forwarded: readonly string[]): Promise<readonly string[]> {
  if (forwarded.length === 0 || forwarded.some(asksForHelp)) {
    return [];
  }
  const { parseCLI } = await import("vitest/node");
  try {
    return parseCLI(["vitest", "run", ...forwarded]).filter;
  } catch (error) {
    process.stderr.write(
      `${LOG_PREFIX} vitest cannot read these arguments: ` +
        `${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`,
    );
    process.exit(MISUSE_EXIT_CODE);
  }
}

/** Whether `argument` is one of the spellings above, attached form included. */
function asksForHelp(argument: string): boolean {
  const name = argument.split("=")[0] ?? argument;
  return PARSER_ANSWERS_BY_PRINTING.includes(name);
}

async function runChangedTier(): Promise<void> {
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
  // Every unit project when nothing was forwarded, because `--changed` is then
  // the whole selection and a lane's commit reaches any of them; the claiming
  // subset when files were, because a file's own project is the only one that
  // can run it and the others would each report an empty selection.
  const fileFilters = await forwardedFileFilters(forwarded);
  const projects =
    fileFilters.length === 0
      ? CHANGED_TIER_PROJECTS
      : await unitProjectsClaiming(fileFilters, packageRoot);
  const result = spawnSync(
    process.execPath,
    [
      resolveVitestEntryPoint(packageRoot),
      "run",
      ...projects.map((project) => `--project=${project}`),
      // AND `--changed` IS DROPPED THE MOMENT A FILE IS NAMED, because the two
      // INTERSECT. A lane that edits a module and forwards that module's test —
      // the ordinary shape, since a change and its coverage are two files —
      // names a file `--changed` does not list, and the intersection is empty:
      // vitest reports no test files and exits 0, which is this script's whole
      // subject arriving through the last door. A caller who names files has
      // stated the selection, so the ref has nothing left to decide; it is still
      // required and still resolved, so a stale one is still reported.
      ...(fileFilters.length === 0 ? [`--changed=${baseRef}`] : []),
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

await runChangedTier();
