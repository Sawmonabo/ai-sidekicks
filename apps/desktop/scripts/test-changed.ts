// `pnpm run test:changed <base-ref> [vitest args...]`: the unit tiers over what changed since a
// base ref. Each rule below stops a run that selects nothing from exiting 0, which a person would
// read as "my changes are covered".
//
// - The ref is the first argument and is attached as `--changed=<ref>`. pnpm appends the caller's
//   arguments after the script's own, and a separate ref landed after `--maxWorkers=2` as a
//   positional file filter that matched no test.
// - A missing ref refuses: bare `--changed` compares the uncommitted state, which is empty on a
//   committed branch, and running everything buries the mistake. Refusals exit
//   `MISUSE_EXIT_CODE`, distinct from the `1` of a failing test.
// - A ref that names no commit refuses: `--changed=<unknown>` prints "No test files found" and
//   exits 0. The ref is resolved as `<ref>^{commit}` because a tree or blob cannot be diffed.
// - Forwarded files choose their own projects instead of a fixed one, because a file owned by an
//   unselected project matches nothing and exits 0. Which project claims a file is asked of the
//   real `TestProject` instances (`project.matchesTestGlob`), since a matcher written here could
//   disagree with the config.
// - `--changed` intersects with a positional filter, so it is dropped once files are named:
//   forwarding a module's test names a file the ref does not list, and the empty intersection
//   exits 0. The ref is still required and resolved so a stale one is reported.
// - Which arguments are files is asked of vitest's own `parseCLI`, not judged by shape: the
//   operand of `--testNamePattern "x"` or `--reporter verbose` would read as a path.
//
// It uses no `import.meta`: it reads argv but never its own path, so it needs no entry guard.
// Module resolution anchors on the package root, the cwd of a package script.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

const LOG_PREFIX = "[test-changed]";

const USAGE =
  "usage: pnpm --filter @ai-sidekicks/desktop run test:changed <base-ref> [vitest args...]";

/**
 * What a misuse exits with. vitest exits `1` on a failing test, so a refusal exiting `1` would
 * look like a red suite, and one exiting `0` would be the silent success this script ends.
 */
const MISUSE_EXIT_CODE = 2;

/**
 * The projects the changed-file run may use. Each runs from a clean checkout with
 * no prior `pnpm build`: `bundle` reads `out/**`, `smoke`, `e2e` and `endurance` launch Electron,
 * and the browser-mode tiers need a real browser. A file owned by one of those is refused, not
 * skipped. The names are checked against the resolved project set, so a rename in the vitest
 * config fails this script instead of shrinking what it verifies.
 */
const CHANGED_TIER_PROJECTS: readonly string[] = ["main-unit", "renderer"];

/** Held here rather than in the script line, which is what the caller appends to. */
const CHANGED_TIER_WORKERS = "2";

/**
 * The vitest CLI entry point, resolved rather than spawned by name: `node_modules/.bin/vitest` is
 * a shell script on POSIX and a `.CMD` on Windows, so the package's `bin` module runs under
 * `process.execPath`.
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
 * Refuses unless `baseRef` names a commit git can diff. Both git streams are captured so a refusal
 * is this script speaking and a success leaves stderr empty. A git that could not run is reported
 * apart from a ref that did not resolve, since the repairs differ.
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
 * The unit projects that would discover each forwarded file, asked of the runner. Resolving loads
 * the config and builds the `TestProject` instances (about 200 ms) without collecting a suite or
 * launching a browser, and `vitest/node` is imported lazily so a `--changed`-only run or a
 * `--help` probe pays none of it. A file no unit project claims is refused, because vitest treats
 * such a filter as an empty selection and exits 0.
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
 * The spellings vitest's parser answers by printing. `--help` and `-h` make cac write the option
 * list (9917 bytes on vitest 4.1.11) to this process's stdout and return an empty filter, which
 * would put a second copy of vitest's help above the child's. `--version` prints nothing, so it is
 * absent.
 */
const PARSER_ANSWERS_BY_PRINTING: readonly string[] = ["--help", "-h"];

/**
 * Which forwarded arguments vitest would read as file filters, asked of vitest's own `parseCLI`
 * so this script and the child cannot disagree and no arity table here can go stale. A shape rule
 * would read the operand of `--testNamePattern "x"` or `--reporter verbose` as a file.
 * `--update foo.test.ts` yields no filter because `--update` takes an optional argument and eats
 * the operand, as it does in the child. A parse failure, such as cac rejecting `--silent
 * foo.test.ts`, is reported as this script's refusal. The options this script adds use the
 * attached `--name=value` form and cannot consume a caller's operand.
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
  // Before the vitest entry point is resolved: the refusal is about the caller's argument, and
  // "vitest publishes no bin" would name the wrong repair.
  refuseUnlessBaseRefResolves(baseRef, packageRoot);
  // Every unit project when nothing was forwarded, because `--changed` is then the whole
  // selection; otherwise only the claiming ones, since the others would each select nothing.
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
      // `--changed` is dropped once a file is named, because the two intersect and an empty
      // intersection exits 0. The ref is still required and resolved.
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
  // A signaled run has a null status; exiting 0 would report a killed suite as passing.
  if (result.status === null) {
    process.stderr.write(`${LOG_PREFIX} vitest was terminated by ${String(result.signal)}.\n`);
    process.exit(1);
  }
  process.exit(result.status);
}

await runChangedTier();
