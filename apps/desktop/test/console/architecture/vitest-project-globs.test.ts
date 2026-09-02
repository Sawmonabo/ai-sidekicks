// One project owns each test file — no file unowned, no file owned twice.
//
// The console's tiers are separated by Vitest project, and the separation is not
// bookkeeping: each project carries the environment, the build-time defines, and
// the resolve conditions its tier needs. A file discovered by two projects runs
// twice under two environments, and the run that is wrong for it fails for a
// reason that has nothing to do with the code — a browser-tier geometry
// assertion measuring happy-dom's zeroes, a node-tier driver handed a DOM. A file
// discovered by NO project silently does not run at all, which is the worse of
// the two: it is green forever and it is green because nobody executed it.
//
// Both failures are properties of the glob SET rather than of any one glob, so
// neither is visible while reading a single project block — which is why the
// config's own comments say "every glob is disjoint" and why that sentence needs
// something behind it.
//
// WHY THIS DRIVES VITEST RATHER THAN THE CONFIG OBJECT
//
// Importing `vitest.config.ts` and matching its globs here would need a matcher
// of our own, and a matcher that is not the runner's can agree with the config
// and still disagree with the run: brace expansion, whether `**` spans zero
// segments, how `exclude` composes with `include`. `createVitest` resolves the
// real config file and hands back the real `TestProject` instances, so the
// question asked here — "which project would discover this file" — is answered by
// the code that will actually discover it. It costs about two hundred
// milliseconds and no browser is launched: the projects are resolved, never run.
//
// The project list is therefore never written down here, and neither are the
// globs. Adding a fourteenth project changes nothing in this file.

import { globSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createVitest, type Vitest } from "vitest/node";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..", "..", "..");
const VITEST_CONFIG_PATH = join(PACKAGE_ROOT, "vitest.config.ts");

/**
 * What a test file is NAMED, independent of any project's opinion.
 *
 * Deliberately wider than the union of the configured globs — `.spec.` and the
 * JavaScript extensions are matched even though nothing in the tree uses them —
 * because the orphan half of this check is about files no glob claims, and an
 * enumeration derived from the globs could not find one by construction.
 */
const TEST_FILE_PATTERN = "**/*.{test,spec,bench}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}";

/** Directories that hold build output, dependencies, or a runner's scratch. */
const NOT_SOURCE = new Set([
  "node_modules",
  "out",
  "dist",
  "coverage",
  ".git",
  ".turbo",
  ".vitest-attachments",
]);

/**
 * A project, reduced to the one question this file asks it.
 *
 * The indirection exists so the ownership rule below can be run over inputs that
 * are not the real config — which is the only way to show the rule can fail.
 */
interface ProjectMatcher {
  readonly name: string;
  readonly claims: (absolutePath: string) => boolean;
}

/** Which projects claim each file. The rule, stated once, run over any matchers. */
function ownersByFile(
  matchers: readonly ProjectMatcher[],
  relativePaths: readonly string[],
): Map<string, readonly string[]> {
  const owners = new Map<string, readonly string[]>();
  for (const relativePath of relativePaths) {
    const absolutePath = join(PACKAGE_ROOT, relativePath);
    owners.set(
      relativePath,
      matchers.filter((matcher) => matcher.claims(absolutePath)).map((matcher) => matcher.name),
    );
  }
  return owners;
}

function filesOwnedBy(
  owners: ReadonlyMap<string, readonly string[]>,
  count: (ownerCount: number) => boolean,
): readonly string[] {
  return [...owners]
    .filter(([, projectNames]) => count(projectNames.length))
    .map(([relativePath, projectNames]) => `${relativePath} → [${projectNames.join(", ")}]`);
}

/** Every test-shaped FILE in the package. Directories are excluded deliberately. */
function discoverTestFiles(): readonly string[] {
  return globSync(TEST_FILE_PATTERN, {
    cwd: PACKAGE_ROOT,
    exclude: (name) => NOT_SOURCE.has(name),
  })
    .filter((relativePath) => statSync(join(PACKAGE_ROOT, relativePath)).isFile())
    .sort();
}

let vitest: Vitest;
let matchers: readonly ProjectMatcher[];
let testFiles: readonly string[];

beforeAll(async () => {
  vitest = await createVitest("test", {
    watch: false,
    run: true,
    root: PACKAGE_ROOT,
    config: VITEST_CONFIG_PATH,
  });
  matchers = vitest.projects.map((project) => ({
    name: project.name,
    claims: (absolutePath: string) => project.matchesTestGlob(absolutePath),
  }));
  testFiles = discoverTestFiles();
}, 60_000);

afterAll(async () => {
  await vitest.close();
});

describe("vitest projects — every test file has exactly one owner", () => {
  it("resolves a project set worth checking", () => {
    // Everything below is a claim about a set, and every one of them is
    // vacuously true over an empty one. A config that failed to resolve its
    // projects, or a tree with no tests in it, would otherwise report green.
    expect(matchers.length).toBeGreaterThan(1);
    expect(testFiles.length).toBeGreaterThan(1);
    expect(matchers.map((matcher) => matcher.name)).not.toContain("");
  });

  it("leaves no file unclaimed", () => {
    const orphans = filesOwnedBy(ownersByFile(matchers, testFiles), (count) => count === 0);
    // A file no project globs never runs, and never runs green — it reports
    // nothing at all, which reads exactly like a suite that passed.
    expect(orphans).toStrictEqual([]);
  });

  it("lets no two projects claim one file", () => {
    const contested = filesOwnedBy(ownersByFile(matchers, testFiles), (count) => count > 1);
    // The message carries the file and both project names, because "the globs
    // overlap" without them sends a reader through thirteen config blocks.
    expect(contested).toStrictEqual([]);
  });
});

describe("vitest projects — the carve-outs hold on paths that do not exist yet", () => {
  // Matching is a question about a PATH, so these ask it of files nobody has
  // written. That is the only way to check a carve-out whose overlap the current
  // tree does not happen to contain: the co-located console tests sit beside
  // their modules rather than in a `__tests__` directory, so today's files never
  // exercise the exclusion that keeps the console out of the renderer tier.

  it("gives a console test under `__tests__` exactly one owner", () => {
    // Two projects' include globs cover this path — the renderer tier's
    // `__tests__` glob and the console tier's own — and one exclusion is the
    // whole reason the answer is one rather than two. Write this file for real
    // without that exclusion and it runs twice, in two environments.
    const owners = ownersByFile(matchers, [
      "src/renderer/src/console/some-family/__tests__/thing.test.tsx",
    ]);
    expect([...owners.values()][0]).toHaveLength(1);
  });

  it("gives a non-console renderer test under `__tests__` exactly one owner", () => {
    const owners = ownersByFile(matchers, [
      "src/renderer/src/some-family/__tests__/thing.test.tsx",
    ]);
    expect([...owners.values()][0]).toHaveLength(1);
  });

  it("negative control: a path outside every glob is claimed by nobody", () => {
    // Without this, the two cases above pass over a `claims` that answered true
    // once for every path and a counter that could only ever report one.
    const owners = ownersByFile(matchers, ["somewhere/else/thing.test.ts"]);
    expect([...owners.values()][0]).toStrictEqual([]);
  });
});

describe("vitest projects — the check itself can fail", () => {
  const alwaysClaims = (name: string): ProjectMatcher => ({ name, claims: () => true });
  const neverClaims = (name: string): ProjectMatcher => ({ name, claims: () => false });

  it("reports a file two projects claim", () => {
    const owners = ownersByFile([alwaysClaims("alpha"), alwaysClaims("beta")], ["a/b.test.ts"]);
    expect(filesOwnedBy(owners, (count) => count > 1)).toStrictEqual([
      "a/b.test.ts → [alpha, beta]",
    ]);
  });

  it("reports a file no project claims", () => {
    const owners = ownersByFile([neverClaims("alpha"), neverClaims("beta")], ["a/b.test.ts"]);
    expect(filesOwnedBy(owners, (count) => count === 0)).toStrictEqual(["a/b.test.ts → []"]);
  });

  it("reports nothing when exactly one claims it", () => {
    const owners = ownersByFile([alwaysClaims("alpha"), neverClaims("beta")], ["a/b.test.ts"]);
    expect(filesOwnedBy(owners, (count) => count !== 1)).toStrictEqual([]);
  });
});
