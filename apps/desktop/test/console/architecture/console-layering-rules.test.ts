// The two layering rules that had no failing control until now.
//
// `structure:layering` is a command, not a suite: it reports on THIS tree, and a
// tree that happens not to contain a violation reports clean whether the rule
// exists or not. Two rules landed here whose subject does not exist yet — the six
// view families are unlanded branches, and the console carries exactly one
// barrel-to-barrel forward that this same change removed — so without a planted
// control both would have shipped green and unproven.
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
  "bridge/growth-values/sessions.ts": `export interface GrowthSessionSummary {\n  readonly sessionId: string;\n}\n`,
  "bridge/growth-values/index.ts": `export type { GrowthSessionSummary } from "./sessions.js";\n`,
  "bridge/growth-signatures.ts": `import type { GrowthSessionSummary } from "./growth-values/index.js";\n\nexport type SessionDirectoryReply = readonly GrowthSessionSummary[];\n`,
  "bridge/index.ts": `export type { GrowthSessionSummary } from "./growth-values/sessions.js";\nexport type { SessionDirectoryReply } from "./growth-signatures.js";\n`,
  "seats/pane-address.ts": `export interface ConsolePaneRegistry {\n  readonly size: number;\n}\n`,
  "seats/index.ts": `export type { ConsolePaneRegistry } from "./pane-address.js";\n`,
  "panes/index.ts": `import type { ConsolePaneRegistry } from "../seats/index.js";\n\nexport function registerConsolePanes(registry: ConsolePaneRegistry): number {\n  return registry.size;\n}\n`,
  "collaboration/SentInvites.ts": `import type { ConsoleRefusal } from "../core/refusal.js";\n\nexport type InviteRefusal = ConsoleRefusal;\n`,
  "repos/RepoList.ts": `import type { ConsoleRefusal } from "../core/refusal.js";\n\nexport type RepoRefusal = ConsoleRefusal;\n`,
};

/** The forward this change removed: a family door reaching another door instead of a module. */
const BARREL_CHAIN_TREE: PlantedTree = {
  ...CLEAN_TREE,
  "bridge/index.ts": `export type { GrowthSessionSummary } from "./growth-values/index.js";\nexport type { SessionDirectoryReply } from "./growth-signatures.js";\n`,
};

/** The sibling edge the r9 rule set left green: one view family reaching another. */
const VIEW_FAMILY_EDGE_TREE: PlantedTree = {
  ...CLEAN_TREE,
  "collaboration/SentInvites.ts": `import type { RepoRefusal } from "../repos/RepoList.js";\n\nexport type InviteRefusal = RepoRefusal;\n`,
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
  const cruised = await cruise(["src"], {
    ...configuration.options,
    ruleSet: { forbidden: configuration.forbidden },
    validate: true,
    baseDir: plantRoot,
  });
  if (typeof cruised.output === "string") {
    throw new TypeError("expected a cruise result object, not a formatted report");
  }
  return cruised.output.summary.violations
    .filter(
      (violation) =>
        violation.rule.name === BARREL_CHAIN_RULE ||
        violation.rule.name === VIEW_FAMILY_ISOLATION_RULE,
    )
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
      `${VIEW_FAMILY_ISOLATION_RULE}: ${join(CONSOLE_ROOT, "collaboration/SentInvites.ts")} → ${join(CONSOLE_ROOT, "repos/RepoList.ts")}`,
    ]);
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
