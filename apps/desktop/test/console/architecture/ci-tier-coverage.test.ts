// Every Vitest project this package declares runs in a required CI check.
//
// A tier that exists, has a script, has a Turbo task, and is named by no job the
// merge gate depends on is worse than a tier nobody wrote: it is read as coverage
// on every review, and it stops nothing. That failure has already happened here
// once — `.github/workflows/ci.yml` records it in the desktop step's own comment,
// where `main-unit` landed in `pnpm test` and in no required check, leaving every
// `src/main/**` unit unguarded on merge — and the enumeration that caused it is
// deliberate: the desktop step names one Turbo task at a time so the Electron and
// browser tiers cannot be scheduled beside each other, which is exactly what makes
// a newly added project invisible to it by construction.
//
// So the enumeration needs a checker rather than a convention. This file is it.
//
// WHAT IT READS, AND WHY EACH SOURCE IS THE REAL ONE
//
//   • The PROJECTS come from `createVitest`, not from a list written down here:
//     a fourteenth project has to be discovered, or this check would be green for
//     exactly the project nobody wired.
//   • The SCRIPTS come from `package.json`, matched by the `--project=` selector
//     each one carries, so a script renamed without its project moving is a
//     failure rather than a silent re-point.
//   • The REQUIRED JOBS come from `ci-gate`'s own `needs:` list. Branch protection
//     requires that one job (ADR-023 §Axis 1), so "required" is a property of that
//     list and of nothing else — a job added to the workflow and left off it gates
//     nothing, and this file will not count it.
//
// The workflow is read as text and scanned by shape rather than parsed as YAML:
// no YAML parser is a dependency of this package, and adding one to answer three
// structural questions about one file would be a worse trade than a scan that
// fails loudly when the file's shape moves. Every helper below is exercised on
// synthetic input at the bottom, including the one case a text scan could get
// wrong — a script named only inside a comment.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { resolveVitestProjects } from "../vitest-projects.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..", "..", "..");
const REPOSITORY_ROOT = resolve(PACKAGE_ROOT, "..", "..");
const WORKFLOW_PATH = join(REPOSITORY_ROOT, ".github", "workflows", "ci.yml");
const PACKAGE_MANIFEST_PATH = join(PACKAGE_ROOT, "package.json");

/** The job branch protection requires; every other required job hangs off its `needs`. */
const MERGE_GATE_JOB_NAME = "ci-gate";

/** The script a developer runs, and the set CI's enumeration is measured against. */
const AGGREGATE_SCRIPT_NAME = "test";

/**
 * Projects deliberately absent from the aggregate `test` script, with the reason.
 *
 * An entry here is a claim that a developer running `pnpm test` is right not to
 * run this tier — never that the tier is optional. `console-screenshot` is still
 * required in CI through its own job, and the check below asserts that.
 */
const AGGREGATE_EXEMPT_PROJECTS: ReadonlyMap<string, string> = new Map([
  [
    "console-screenshot",
    "Vitest keys a reference by browser AND platform and this repository commits the darwin set " +
      "only, so the tier can only pass on the one runner class `console-screenshot-macos` pins. " +
      "Listing it here would make `pnpm test` red on every Linux and Windows machine, against a " +
      "reference nobody can regenerate there.",
  ],
  [
    "console-bench",
    "Not one of the nine tiers: it records timings into a ledger a person reads. A benchmark " +
      "that can fail a gate is a gate that fails on someone else's noisy laptop.",
  ],
]);

/**
 * Projects deliberately absent from every required CI job, with the reason.
 *
 * Strictly smaller than the aggregate exemptions, and it has to be: a tier can be
 * too platform-bound for an arbitrary developer machine and still be required on
 * a runner class the workflow pins.
 */
const REQUIRED_CI_EXEMPT_PROJECTS: ReadonlyMap<string, string> = new Map([
  [
    "console-bench",
    "It gates nothing by construction, so there is no required check for it to be named in.",
  ],
]);

/** Escape a literal for embedding in a `RegExp`. One implementation, two callers. */
function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The lines of each job in a GitHub workflow, keyed by job name.
 *
 * Shape-scanned rather than parsed: a job key is the only thing indented exactly
 * two spaces under `jobs:`. Throws when the file's shape moves, because a scan
 * that silently found nothing would make every claim below vacuous.
 */
function parseJobLines(workflowText: string): ReadonlyMap<string, readonly string[]> {
  const lines = workflowText.split("\n");
  const jobsKeyIndex = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsKeyIndex === -1) {
    throw new Error("no top-level `jobs:` key");
  }
  const jobLines = new Map<string, readonly string[]>();
  let currentJobName: string | null = null;
  let currentJobLines: string[] = [];
  for (const line of lines.slice(jobsKeyIndex + 1)) {
    if (/^[A-Za-z]/.test(line)) {
      break; // A new top-level key ends the jobs block.
    }
    const jobKeyMatch = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (jobKeyMatch === null) {
      currentJobLines.push(line);
      continue;
    }
    if (currentJobName !== null) {
      jobLines.set(currentJobName, currentJobLines);
    }
    currentJobName = jobKeyMatch[1] ?? "";
    currentJobLines = [];
  }
  if (currentJobName !== null) {
    jobLines.set(currentJobName, currentJobLines);
  }
  if (jobLines.size === 0) {
    throw new Error("the `jobs:` block declares no jobs");
  }
  return jobLines;
}

/** The jobs the merge gate depends on — the whole of what "required" means here. */
function parseRequiredJobNames(
  jobLines: ReadonlyMap<string, readonly string[]>,
  gateJobName: string,
): readonly string[] {
  const gateLines = jobLines.get(gateJobName);
  if (gateLines === undefined) {
    throw new Error(`the workflow declares no \`${gateJobName}\` job`);
  }
  for (const line of gateLines) {
    const needsMatch = /^\s*needs:\s*\[([^\]]+)\]\s*$/.exec(line);
    if (needsMatch !== null) {
      return (needsMatch[1] ?? "").split(",").map((jobName) => jobName.trim());
    }
  }
  throw new Error(`\`${gateJobName}\` declares no \`needs:\` list`);
}

/**
 * Whether `scriptName` is invoked on a line that is not a comment.
 *
 * The comment carve-out is the whole point: `ci.yml` names tasks in prose all
 * over its comment blocks, and counting those would report the exact gap this
 * file exists to find as already closed.
 */
function namesScript(lines: readonly string[], scriptName: string): boolean {
  const token = new RegExp(`(?<![\\w:./-])${escapeForRegExp(scriptName)}(?![\\w-])`);
  return lines.some((line) => !line.trimStart().startsWith("#") && token.test(line));
}

interface PackageManifest {
  readonly scripts: Readonly<Record<string, string>>;
}

function readPackageManifest(): PackageManifest {
  const parsed: unknown = JSON.parse(readFileSync(PACKAGE_MANIFEST_PATH, "utf8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("scripts" in parsed) ||
    typeof parsed.scripts !== "object" ||
    parsed.scripts === null
  ) {
    throw new Error(`${PACKAGE_MANIFEST_PATH} declares no scripts block`);
  }
  return parsed as PackageManifest;
}

/**
 * The name `--project=` selects, which is not always the name Vitest resolves.
 *
 * A browser-mode project comes back with its instance appended — `console-browser`
 * resolves as `console-browser (chromium)` — because Vitest declares one project
 * per browser. The `--project` filter still matches the base name, and that is
 * what the package scripts and the workflow both spell, so a script is looked up
 * by the base name rather than by the resolved one. Verified against the runner
 * rather than assumed: `vitest list --project=console-browser` collects the
 * `console-browser (chromium)` project's files.
 */
function selectorNameFor(projectName: string): string {
  return projectName.replace(/ \([^)]*\)$/, "");
}

/**
 * The scripts that select a given Vitest project, by `--project=` match.
 *
 * Several is legitimate and is not drift: `renderer` is selected by both
 * `test:renderer` and `test:coverage`, which run in different jobs and answer
 * different questions. None is the failure — a project no script names cannot be
 * reached from anywhere.
 */
function scriptsSelecting(manifest: PackageManifest, selectorName: string): readonly string[] {
  const selector = new RegExp(`--project=${escapeForRegExp(selectorName)}(?![\\w-])`);
  return Object.entries(manifest.scripts)
    .filter(([, command]) => selector.test(command))
    .map(([scriptName]) => scriptName);
}

const manifest = readPackageManifest();
const jobLines = parseJobLines(readFileSync(WORKFLOW_PATH, "utf8"));
const requiredJobNames = parseRequiredJobNames(jobLines, MERGE_GATE_JOB_NAME);

/** Every project, by the name `--project=` selects it with. */
let selectorNames: readonly string[] = [];

beforeAll(async () => {
  const resolved = await resolveVitestProjects();
  try {
    selectorNames = resolved.projects.map((project) => selectorNameFor(project.name));
  } finally {
    await resolved.close();
  }
}, 60_000);

function scriptsFor(selectorName: string): readonly string[] {
  return scriptsSelecting(manifest, selectorName);
}

function reachabilityGaps(
  exemptions: ReadonlyMap<string, string>,
  isReachable: (scriptName: string) => boolean,
): readonly string[] {
  return selectorNames
    .filter((selectorName) => !exemptions.has(selectorName))
    .filter((selectorName) => !scriptsFor(selectorName).some(isReachable))
    .map(
      (selectorName) => `${selectorName} (${scriptsFor(selectorName).join(", ") || "no script"})`,
    );
}

describe("console test tiers — every project reaches a required check", () => {
  it("resolves a project set and a required-job set worth checking", () => {
    // Every claim below is a statement about these two sets, and every one of
    // them is vacuously true over an empty one.
    expect(selectorNames.length).toBeGreaterThan(1);
    expect(new Set(selectorNames).size, "two projects select on one name").toBe(
      selectorNames.length,
    );
    expect(requiredJobNames.length).toBeGreaterThan(1);
    expect(requiredJobNames).toContain("test-node22");
    expect(manifest.scripts[AGGREGATE_SCRIPT_NAME] ?? "").not.toBe("");
  });

  it("gives every project at least one selecting script", () => {
    // Zero makes both reachability checks below unanswerable: there is no name a
    // workflow line or the aggregate could carry.
    expect(
      selectorNames.filter((selectorName) => scriptsFor(selectorName).length === 0),
    ).toStrictEqual([]);
  });

  it("names every non-exempt project in the aggregate `test` script", () => {
    const aggregateCommand = [manifest.scripts[AGGREGATE_SCRIPT_NAME] ?? ""];
    expect(
      reachabilityGaps(AGGREGATE_EXEMPT_PROJECTS, (scriptName) =>
        namesScript(aggregateCommand, scriptName),
      ),
      "a developer's `pnpm test` and CI must run the same set: add the script to the aggregate, " +
        "or record why it is exempt in AGGREGATE_EXEMPT_PROJECTS",
    ).toStrictEqual([]);
  });

  it("names every non-exempt project in a job `ci-gate` requires", () => {
    expect(
      reachabilityGaps(REQUIRED_CI_EXEMPT_PROJECTS, (scriptName) =>
        requiredJobNames.some((jobName) => namesScript(jobLines.get(jobName) ?? [], scriptName)),
      ),
      `a tier no job in [${requiredJobNames.join(", ")}] invokes runs in no required check, so a ` +
        "regression in it merges green",
    ).toStrictEqual([]);
  });

  it("lets no exemption outlive the project it names", () => {
    const stale = [...AGGREGATE_EXEMPT_PROJECTS.keys(), ...REQUIRED_CI_EXEMPT_PROJECTS.keys()]
      .filter((selectorName) => !selectorNames.includes(selectorName))
      .sort();
    expect(stale, "an exemption naming a project that no longer exists").toStrictEqual([]);
  });

  it("gives every exemption a reason long enough to be one", () => {
    for (const [projectName, reason] of [
      ...AGGREGATE_EXEMPT_PROJECTS,
      ...REQUIRED_CI_EXEMPT_PROJECTS,
    ]) {
      expect(reason.length, `${projectName}: reason`).toBeGreaterThan(60);
    }
  });
});

// Negative controls. Each helper above is the reason a clean result means
// anything, so each is shown failing on an input built to defeat it.
describe("the workflow scan itself can fail", () => {
  const WORKFLOW_FIXTURE = [
    "name: CI",
    "jobs:",
    "  build-it:",
    "    steps:",
    "      # runs pnpm run test:mentioned-only-in-a-comment",
    "      - run: pnpm run test:really-run",
    "  ci-gate:",
    "    needs: [build-it, other-job]",
    "  other-job:",
    "    steps:",
    "      - run: pnpm run test:elsewhere",
  ].join("\n");

  const fixtureJobLines = parseJobLines(WORKFLOW_FIXTURE);

  it("finds each job and stops at the next one", () => {
    expect([...fixtureJobLines.keys()]).toStrictEqual(["build-it", "ci-gate", "other-job"]);
    expect(namesScript(fixtureJobLines.get("build-it") ?? [], "test:elsewhere")).toBe(false);
  });

  it("refuses a workflow with no jobs block", () => {
    expect(() => parseJobLines("name: CI\n")).toThrow(/jobs:/);
  });

  it("refuses a jobs block that declares no job", () => {
    expect(() => parseJobLines("jobs:\n")).toThrow(/no jobs/);
  });

  it("reads the gate's needs list, and refuses a gate without one", () => {
    expect(parseRequiredJobNames(fixtureJobLines, "ci-gate")).toStrictEqual([
      "build-it",
      "other-job",
    ]);
    expect(() => parseRequiredJobNames(fixtureJobLines, "no-such-job")).toThrow(/no-such-job/);
    expect(() => parseRequiredJobNames(fixtureJobLines, "other-job")).toThrow(/needs:/);
  });

  it("does not count a script named only in a comment", () => {
    const buildItLines = fixtureJobLines.get("build-it") ?? [];
    expect(namesScript(buildItLines, "test:mentioned-only-in-a-comment")).toBe(false);
    expect(namesScript(buildItLines, "test:really-run")).toBe(true);
  });

  it("does not count a longer script name that merely starts the same way", () => {
    const buildItLines = fixtureJobLines.get("build-it") ?? [];
    expect(namesScript(buildItLines, "test:really")).toBe(false);
    expect(namesScript(["      - run: pnpm run xtest:really-run"], "test:really-run")).toBe(false);
  });

  it("distinguishes two project selectors that share a prefix", () => {
    const twoScripts: PackageManifest = {
      scripts: {
        "test:main": "vitest run --project=main",
        "test:main-unit": "vitest run --project=main-unit",
      },
    };
    expect(scriptsSelecting(twoScripts, "main")).toStrictEqual(["test:main"]);
    expect(scriptsSelecting(twoScripts, "main-unit")).toStrictEqual(["test:main-unit"]);
    expect(scriptsSelecting(twoScripts, "absent")).toStrictEqual([]);
  });

  it("reduces a browser-mode project name to the name `--project=` selects", () => {
    expect(selectorNameFor("console-browser (chromium)")).toBe("console-browser");
    expect(selectorNameFor("console-unit")).toBe("console-unit");
    // Only a trailing parenthetical, and only the last one: a project whose own
    // name held brackets would otherwise be silently truncated.
    expect(selectorNameFor("weird (name) project")).toBe("weird (name) project");
  });
});
