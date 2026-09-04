// The three layering rules that had no failing control until now.
//
// `structure:layering` is a command, not a suite: it reports on THIS tree, and a
// tree that happens not to contain a violation reports clean whether the rule
// exists or not. Two rules landed here whose subject does not exist yet — the six
// view families are unlanded branches, and the console carries exactly one
// barrel-to-barrel forward that this same change removed — so without a planted
// control both would have shipped green and unproven. The third, the door rule, is
// the same shape for the same reason: the change that added it also hoisted the two
// modules that violated it, so the tree it lands on is clean by construction and its
// green says nothing about whether it bites.
//
// WHAT IS PLANTED AND WHY IT IS NOT A REIMPLEMENTATION. The rule set under test is
// the real `.dependency-cruiser.mjs`, loaded through dependency-cruiser's own
// config loader — the same loader the CLI uses — and run through the real `cruise`.
// Only the SUBJECT is synthetic: a module tree written into a temporary directory
// at the same relative paths the rules are anchored on (`src/renderer/src/console/…`),
// so `baseDir` is the whole of the difference between this run and the CLI's. No
// path regex, family list, or dependency type is restated here.
//
// WHY NOT PLANT INTO THE REAL TREE. The aggregate `test` script runs this tier
// alongside `console-unit` in one Turbo batch, so a fixture written under `src/`
// would be visible to a concurrently building sibling; and a crash between the
// write and the delete would leave a violation in the tree that the next
// `structure` run reports as real.

import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cruise } from "dependency-cruiser";
import extractDepcruiseConfig from "dependency-cruiser/config-utl/extract-depcruise-config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..", "..", "..");
const CONFIG_PATH = resolve(PACKAGE_ROOT, ".dependency-cruiser.mjs");

/** Where the rules are anchored, relative to the package root they are run from. */
const CONSOLE_ROOT = join("src", "renderer", "src", "console");

/** The rule names this file owns. Everything else the cruise reports is another test's. */
const BARREL_CHAIN_RULE = "console-no-barrel-chain";
const VIEW_FAMILY_ISOLATION_RULE = "console-view-family-isolation";
const DEEP_IMPORT_RULE = "console-cross-family-deep-import";
const OWNED_RULES = [BARREL_CHAIN_RULE, VIEW_FAMILY_ISOLATION_RULE, DEEP_IMPORT_RULE];

type PlantedTree = Readonly<Record<string, string>>;

/**
 * The shape the console has AFTER this change, reduced to the modules the two rules
 * can see.
 *
 * Every member is here because a rule could misfire on it: the sub-module door that
 * must stay legal, the family door that must reach past it to the declaring module,
 * the composition site that imports a family door for a type in its signature, and
 * two view families that mind their own business.
 */
const CLEAN_TREE: PlantedTree = {
  "core/refusal.ts": `export interface ConsoleRefusal {\n  readonly code: string;\n}\n`,
  "core/index.ts": `export type { ConsoleRefusal } from "./refusal.js";\n`,
  "bridge/growth-values/sessions.ts": `export interface GrowthSessionSummary {\n  readonly sessionId: string;\n}\n`,
  "bridge/growth-values/index.ts": `export type { GrowthSessionSummary } from "./sessions.js";\n`,
  "bridge/growth-signatures.ts": `import type { GrowthSessionSummary } from "./growth-values/index.js";\n\nexport type SessionDirectoryReply = readonly GrowthSessionSummary[];\n`,
  "bridge/index.ts": `export type { GrowthSessionSummary } from "./growth-values/sessions.js";\nexport type { SessionDirectoryReply } from "./growth-signatures.js";\n`,
  "seats/pane-address.ts": `export interface ConsolePaneRegistry {\n  readonly size: number;\n}\n`,
  "seats/index.ts": `export type { ConsolePaneRegistry } from "./pane-address.js";\n`,
  "frame/surface-registry.ts": `export interface ConsoleSurfaceContext {\n  readonly slot: string;\n}\n`,
  "frame/session-lifecycle.ts": `export interface ActiveSession {\n  readonly sessionId: string;\n}\n`,
  "frame/index.ts": `export type { ActiveSession } from "./session-lifecycle.js";\n`,
  "panes/index.ts": `import type { ConsolePaneRegistry } from "../seats/index.js";\n\nexport function registerConsolePanes(registry: ConsolePaneRegistry): number {\n  return registry.size;\n}\n`,
  "panes/workflow-run/WorkflowRunPane.ts": `import type { InviteRefusal } from "../../collaboration/SentInvites.js";\n\nexport type PaneRefusal = InviteRefusal;\n`,
  "collaboration/SentInvites.ts": `import type { ConsoleRefusal } from "../core/index.js";\nimport type { ConsoleSurfaceContext } from "../frame/surface-registry.js";\n\nexport type InviteRefusal = ConsoleRefusal & { readonly context: ConsoleSurfaceContext };\n`,
  "repos/RepoList.ts": `import type { ConsoleRefusal } from "../core/index.js";\n\nexport type RepoRefusal = ConsoleRefusal;\n`,
  "repos/index.ts": `export type { RepoRefusal } from "./RepoList.js";\n`,
};

/** The forward this change removed: a family door reaching another door instead of a module. */
const BARREL_CHAIN_TREE: PlantedTree = {
  ...CLEAN_TREE,
  "bridge/index.ts": `export type { GrowthSessionSummary } from "./growth-values/index.js";\nexport type { SessionDirectoryReply } from "./growth-signatures.js";\n`,
};

/**
 * The sibling edge the r9 rule set left green: one view family reaching another.
 *
 * Written through the target family's DOOR on purpose, so this tree offends exactly
 * one rule. A deep specifier would offend the door rule as well, and a control that
 * trips two rules cannot say which of them was the one that bit.
 */
const VIEW_FAMILY_EDGE_TREE: PlantedTree = {
  ...CLEAN_TREE,
  "collaboration/SentInvites.ts": `import type { RepoRefusal } from "../repos/index.js";\n\nexport type InviteRefusal = RepoRefusal;\n`,
};

/**
 * The shape the door rule was added for: a view family reaching a layer family's
 * MODULE, beside the one deep specifier the rule exempts by name.
 *
 * Both edges leave the same file, which is what makes this one tree two controls: the
 * `frame/session-lifecycle.js` specifier must be reported, and the exempted
 * `frame/surface-registry.js` specifier — carried over from the clean tree — must not.
 * An exemption written against the family rather than the module would report neither.
 */
const DEEP_IMPORT_TREE: PlantedTree = {
  ...CLEAN_TREE,
  "collaboration/SentInvites.ts": `import type { ConsoleRefusal } from "../core/index.js";\nimport type { ConsoleSurfaceContext } from "../frame/surface-registry.js";\nimport type { ActiveSession } from "../frame/session-lifecycle.js";\n\nexport type InviteRefusal = ConsoleRefusal & {\n  readonly context: ConsoleSurfaceContext;\n  readonly session: ActiveSession;\n};\n`,
};

/**
 * A sub-module door reached from OUTSIDE its family, which `apps/desktop/AGENTS.md`
 * says is not a sub-module door at all.
 *
 * The exemption in the rule matches a family door's single path segment, so this
 * nested `index.ts` is not admitted by it — the claim this tree checks, since a
 * regular expression written one segment looser would let any family publish a second
 * door to the rest of the console.
 */
const SUB_MODULE_DOOR_TREE: PlantedTree = {
  ...CLEAN_TREE,
  "repos/RepoList.ts": `import type { GrowthSessionSummary } from "../bridge/growth-values/index.js";\n\nexport type RepoRefusal = GrowthSessionSummary;\n`,
};

let plantRoot = "";

beforeEach(async () => {
  // `realpath` is load-bearing on macOS, where `tmpdir()` is `/var/folders/…`, a symlink
  // to `/private/var/…`: dependency-cruiser resolves modules to their real paths, so a
  // `baseDir` on the symlinked side leaves every module absolute and outside it, and every
  // path-anchored rule silently matches nothing. Measured — without it all four cases
  // report zero violations, including the two that must fail.
  plantRoot = await realpath(await mkdtemp(join(tmpdir(), "console-layering-")));
});

afterEach(async () => {
  await rm(plantRoot, { recursive: true, force: true });
});

async function plant(tree: PlantedTree): Promise<void> {
  for (const [relativePath, contents] of Object.entries(tree)) {
    const absolutePath = join(plantRoot, CONSOLE_ROOT, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, contents, "utf8");
  }
}

/**
 * Run the REAL rule set over the planted tree and report which rules fired, on which edge.
 *
 * `baseDir` is the only thing that differs from a `pnpm structure:layering` run; the
 * forbidden set, the resolver extensions, and the test-file exclusion all come out of
 * the config file itself.
 */
async function violationsFor(tree: PlantedTree): Promise<readonly string[]> {
  await plant(tree);
  const configuration = await extractDepcruiseConfig(CONFIG_PATH);
  const { forbidden } = configuration;
  if (forbidden === undefined) {
    // The loader types the set as optional, and a run over an empty rule set would
    // report clean for every tree — the failure this whole file exists to prevent.
    throw new TypeError("the layering config declares no forbidden rules");
  }
  const cruised = await cruise(["src"], {
    ...configuration.options,
    ruleSet: { forbidden },
    validate: true,
    baseDir: plantRoot,
  });
  if (typeof cruised.output === "string") {
    throw new TypeError("expected a cruise result object, not a formatted report");
  }
  return cruised.output.summary.violations
    .filter((violation) => OWNED_RULES.includes(violation.rule.name))
    .map((violation) => `${violation.rule.name}: ${violation.from} → ${violation.to}`);
}

describe("console layering rules", () => {
  it("passes the shape the console ships", async () => {
    expect(await violationsFor(CLEAN_TREE)).toEqual([]);
  });

  it("fails a family door that re-exports through a sub-module door", async () => {
    expect(await violationsFor(BARREL_CHAIN_TREE)).toEqual([
      `${BARREL_CHAIN_RULE}: ${join(CONSOLE_ROOT, "bridge/index.ts")} → ${join(CONSOLE_ROOT, "bridge/growth-values/index.ts")}`,
    ]);
  });

  it("fails one view family importing another", async () => {
    expect(await violationsFor(VIEW_FAMILY_EDGE_TREE)).toEqual([
      `${VIEW_FAMILY_ISOLATION_RULE}: ${join(CONSOLE_ROOT, "collaboration/SentInvites.ts")} → ${join(CONSOLE_ROOT, "repos/index.ts")}`,
    ]);
  });

  it("fails a cross-family import that names a module instead of the family door", async () => {
    expect(await violationsFor(DEEP_IMPORT_TREE)).toEqual([
      `${DEEP_IMPORT_RULE}: ${join(CONSOLE_ROOT, "collaboration/SentInvites.ts")} → ${join(CONSOLE_ROOT, "frame/session-lifecycle.ts")}`,
    ]);
  });

  it("fails a sub-module door reached from outside its own family", async () => {
    expect(await violationsFor(SUB_MODULE_DOOR_TREE)).toEqual([
      `${DEEP_IMPORT_RULE}: ${join(CONSOLE_ROOT, "repos/RepoList.ts")} → ${join(CONSOLE_ROOT, "bridge/growth-values/index.ts")}`,
    ]);
  });

  it("leaves the pane board's edges into a view family alone", async () => {
    // `panes/` is a composition site: it sits above every family by construction, so
    // its deep specifiers into a view family are composition rather than layering.
    // Stated as its own case because the door rule would report every one of them if
    // the composition subtraction were dropped from either endpoint, and the pane
    // board would become unwritable.
    const everyViolation = [
      ...(await violationsFor(CLEAN_TREE)),
      ...(await violationsFor(DEEP_IMPORT_TREE)),
      ...(await violationsFor(SUB_MODULE_DOOR_TREE)),
    ];
    expect(everyViolation.filter((line) => line.includes("panes/"))).toEqual([]);
  });

  it("leaves the composition site's import of a family door alone", async () => {
    // `panes/index.ts` is in every tree above and never appears in a violation. Stated as
    // its own case because it is the one edge the barrel-chain rule would catch if it
    // matched on the module pair rather than on the `export … from` dependency type, and
    // a rule that reported it would make the pane board unwritable.
    const everyViolation = [
      ...(await violationsFor(CLEAN_TREE)),
      ...(await violationsFor(BARREL_CHAIN_TREE)),
      ...(await violationsFor(VIEW_FAMILY_EDGE_TREE)),
    ];
    expect(everyViolation.filter((line) => line.includes("panes/index.ts"))).toEqual([]);
  });
});
