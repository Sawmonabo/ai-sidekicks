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
//
// ONE CRUISE PER TREE, AND THE TIMEOUT IS DERIVED FROM THAT. A cruise is the
// expensive thing here, and the file used to run six for four cases: three cases
// cruised their own tree and the fourth re-cruised all three to assert a negative
// over the same outputs. Six cruises against vitest's 5 000 ms default passed alone
// and timed out under aggregate tier load, and the case that timed out was the one
// asserting the negative — the one that had computed nothing new. So a tree is
// cruised at most ONCE for the whole file and every case reads that result, which
// makes an aggregate case free and leaves each case with at most one cruise to pay
// for. The timeout then follows the shape `tierTimeoutFor()` uses next door — the
// slices a case can spend, plus the settlement residual that module already owns —
// rather than a literal chosen to be comfortable.

import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cruise } from "dependency-cruiser";
import extractDepcruiseConfig from "dependency-cruiser/config-utl/extract-depcruise-config";
import { afterAll, describe, expect, it } from "vitest";

import { MINIMUM_SETTLEMENT_RESIDUAL_MS } from "../launch-deadline.js";

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

/**
 * What one cruise of a planted tree may cost, in milliseconds.
 *
 * A CEILING FOR A WEDGED CRUISE, not an expectation, on the same posture the launch
 * budgets take: what it guards is a cruise that never settles, so what matters is
 * that some finite figure is enforced and that a case which overruns it says which
 * cruise it was rather than taking vitest's undiagnosable kill.
 *
 * Measured rather than chosen. On an idle eight-core Apple-silicon host each of the
 * three cruises settles in 65-110 ms and the whole file in 262 ms of test time. Ten
 * seconds is two orders of magnitude over that, which is the margin the tier needs:
 * the failure this replaces was not a slow cruise but a cruise queued behind
 * twenty-eight other architecture files under the pool's default parallelism, where
 * what a case waits out is contention rather than work.
 *
 * It is a constant here rather than a `budgets.json` row for the reason that registry
 * states about `MINIMUM_SETTLEMENT_RESIDUAL_MS`: the rows there are the slices of the
 * ONE launch-tier timeout, a set claim their derivation makes explicitly, and this
 * tier launches nothing.
 */
const CRUISE_ALLOWANCE_MS = 10_000;

/** What a case may spend, given how many cruises it can be the first to reach. */
function layeringTimeoutFor(cruises: number): number {
  return cruises * CRUISE_ALLOWANCE_MS + MINIMUM_SETTLEMENT_RESIDUAL_MS;
}

/** What a case naming ONE tree may spend. */
const ONE_TREE_MS = layeringTimeoutFor(1);

/**
 * What the aggregate case may spend: one allowance per tree it NAMES.
 *
 * Not per tree it cruises, which in practice is none — every tree it names has been
 * answered by the case above it. Budgeting the names rather than the cruises makes
 * the figure independent of the order the cases run in, which a budget that assumed
 * a warm memo would not be.
 */
const EVERY_TREE_MS = layeringTimeoutFor(3);

const plantRoots: string[] = [];
const cruisedTrees = new Map<PlantedTree, Promise<readonly string[]>>();

afterAll(async () => {
  await Promise.all(plantRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function plant(tree: PlantedTree): Promise<string> {
  // `realpath` is load-bearing on macOS, where `tmpdir()` is `/var/folders/…`, a symlink
  // to `/private/var/…`: dependency-cruiser resolves modules to their real paths, so a
  // `baseDir` on the symlinked side leaves every module absolute and outside it, and every
  // path-anchored rule silently matches nothing. Measured — without it all four cases
  // report zero violations, including the two that must fail.
  const plantRoot = await realpath(await mkdtemp(join(tmpdir(), "console-layering-")));
  plantRoots.push(plantRoot);
  for (const [relativePath, contents] of Object.entries(tree)) {
    const absolutePath = join(plantRoot, CONSOLE_ROOT, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, contents, "utf8");
  }
  return plantRoot;
}

/**
 * Which rules fired on `tree`, on which edge — cruised once and remembered.
 *
 * Keyed on the tree OBJECT rather than on its contents: every tree is a module-level
 * constant, so identity is exactly the right key and no hashing of file contents has
 * to agree with it. A case that asks for the same tree twice is answered from the
 * pending promise, so two cases racing for one tree still cruise it once.
 */
function violationsFor(tree: PlantedTree): Promise<readonly string[]> {
  const already = cruisedTrees.get(tree);
  if (already !== undefined) {
    return already;
  }
  const cruising = cruiseOnce(tree);
  cruisedTrees.set(tree, cruising);
  return cruising;
}

/**
 * Run the REAL rule set over the planted tree and report which rules fired, on which edge.
 *
 * `baseDir` is the only thing that differs from a `pnpm structure:layering` run; the
 * forbidden set, the resolver extensions, and the test-file exclusion all come out of
 * the config file itself.
 */
async function cruiseOnce(tree: PlantedTree): Promise<readonly string[]> {
  const plantRoot = await plant(tree);
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
    .filter(
      (violation) =>
        violation.rule.name === BARREL_CHAIN_RULE ||
        violation.rule.name === VIEW_FAMILY_ISOLATION_RULE,
    )
    .map((violation) => `${violation.rule.name}: ${violation.from} → ${violation.to}`);
}

describe("console layering rules", () => {
  it(
    "passes the shape the console ships",
    async () => {
      expect(await violationsFor(CLEAN_TREE)).toEqual([]);
    },
    ONE_TREE_MS,
  );

  it(
    "fails a family door that re-exports through a sub-module door",
    async () => {
      expect(await violationsFor(BARREL_CHAIN_TREE)).toEqual([
        `${BARREL_CHAIN_RULE}: ${join(CONSOLE_ROOT, "bridge/index.ts")} → ${join(CONSOLE_ROOT, "bridge/growth-values/index.ts")}`,
      ]);
    },
    ONE_TREE_MS,
  );

  it(
    "fails one view family importing another",
    async () => {
      expect(await violationsFor(VIEW_FAMILY_EDGE_TREE)).toEqual([
        `${VIEW_FAMILY_ISOLATION_RULE}: ${join(CONSOLE_ROOT, "collaboration/SentInvites.ts")} → ${join(CONSOLE_ROOT, "repos/RepoList.ts")}`,
      ]);
    },
    ONE_TREE_MS,
  );

  it(
    "leaves the composition site's import of a family door alone",
    async () => {
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
    },
    EVERY_TREE_MS,
  );

  it(
    "control: a tree is cruised once, however many cases name it",
    async () => {
      // Without this the memo is invisible: the file would still pass with a cruise per
      // call, at the six-cruise cost that made the aggregate case time out. Identity
      // rather than equality, because what is asserted is that no second cruise ran.
      const first = violationsFor(CLEAN_TREE);
      expect(violationsFor(CLEAN_TREE)).toBe(first);
      expect(cruisedTrees.size).toBeLessThanOrEqual(3);
    },
    ONE_TREE_MS,
  );
});
