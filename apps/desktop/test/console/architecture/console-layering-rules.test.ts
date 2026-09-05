// The four layering rules that had no failing control until now.
//
// `structure:layering` is a command, not a suite: it reports on THIS tree, and a
// tree that happens not to contain a violation reports clean whether the rule
// exists or not. Two rules landed here whose subject does not exist yet — the six
// view families are unlanded branches, and the console carries exactly one
// barrel-to-barrel forward that this same change removed — so without a planted
// control both would have shipped green and unproven. The door rule and the
// pane-board rule are the same shape for the same reason: the change that added them
// also hoisted or moved every module that violated them, so the tree they land on is
// clean by construction and their green says nothing about whether they bite.
//
// WHAT IS PLANTED AND WHY IT IS NOT A REIMPLEMENTATION. The rule set under test is
// the real `.dependency-cruiser.mjs`, loaded through dependency-cruiser's own
// config loader — the same loader the CLI uses — and run through the real `cruise`.
// Only the SUBJECT is synthetic: a module tree written into a temporary directory
// at the same relative paths the rules are anchored on (`src/renderer/src/console/…`),
// so `baseDir` is the whole of the difference between this run and the CLI's. No
// path regex, family list, or dependency type is restated here. The trees themselves
// are `console-layering-trees.ts` beside this file — one module for the subjects, one
// for the harness and the cases, on the seam `barrel-census.ts` already takes.
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

import { existsSync } from "node:fs";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cruise } from "dependency-cruiser";
import extractDepcruiseConfig from "dependency-cruiser/config-utl/extract-depcruise-config";
import { afterEach, describe, expect, it } from "vitest";

import { MINIMUM_SETTLEMENT_RESIDUAL_MS } from "../launch-deadline.js";
import {
  BARREL_CHAIN_TREE,
  CLEAN_TREE,
  DEEP_IMPORT_TREE,
  EVERY_PLANTED_TREE,
  NESTED_PANE_BODY_TREE,
  PANE_BOARD_DEEP_IMPORT_TREE,
  PROOF_TREE,
  RULE_CONTROL_TREES,
  SUB_MODULE_DOOR_TREE,
  VIEW_FAMILY_EDGE_TREE,
  type PlantedTree,
} from "./console-layering-trees.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..", "..", "..");
const CONFIG_PATH = resolve(PACKAGE_ROOT, ".dependency-cruiser.mjs");

/** Where the rules are anchored, relative to the package root they are run from. */
const CONSOLE_ROOT = join("src", "renderer", "src", "console");

/** The rule names this file owns. Everything else the cruise reports is another test's. */
const BARREL_CHAIN_RULE = "console-no-barrel-chain";
const VIEW_FAMILY_ISOLATION_RULE = "console-view-family-isolation";
const DEEP_IMPORT_RULE = "console-cross-family-deep-import";
const FLAT_PANE_BOARD_RULE = "console-pane-board-is-flat";
const OWNED_RULES: readonly string[] = [
  BARREL_CHAIN_RULE,
  VIEW_FAMILY_ISOLATION_RULE,
  DEEP_IMPORT_RULE,
  FLAT_PANE_BOARD_RULE,
];

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
const EVERY_TREE_MS = layeringTimeoutFor(RULE_CONTROL_TREES.length);

/**
 * The cruise results this file has paid for, and the directories it planted to get
 * them.
 *
 * TWO LIFETIMES, AND THEY ARE DELIBERATELY DIFFERENT. A completed cruise RESULT is
 * shared across cases — that is what makes the aggregate case free and keeps each
 * case at one cruise — while the planted DIRECTORY is finished the instant the cruise
 * that read it settles. So the result is kept and the tree is removed at the end of
 * the case that planted it, which is what `apps/desktop/AGENTS.md` requires of every
 * temporary directory and what a removal deferred to the suite's end could not give:
 * every tree on disk for the whole run, and all of them leaked if the worker exits
 * before teardown.
 *
 * Behind private fields on one object rather than two module-level collections,
 * because module-level mutable state is shared by every case in the file and a prior
 * failure or a changed case order then reaches into a later observation.
 */
class PlantedTreeCache {
  readonly #violationsByTree = new Map<PlantedTree, Promise<readonly string[]>>();
  #plantedRoots: string[] = [];
  #removedRoots: string[] = [];

  /**
   * Which rules fired on `tree`, on which edge — cruised once and remembered.
   *
   * Keyed on the tree OBJECT rather than on its contents: every tree is a constant,
   * so identity is exactly the right key and no hashing of file contents has to agree
   * with it. A case that asks for the same tree twice is answered from the pending
   * promise, so two cases racing for one tree still cruise it once.
   */
  public violationsFor(tree: PlantedTree): Promise<readonly string[]> {
    const already = this.#violationsByTree.get(tree);
    if (already !== undefined) {
      return already;
    }
    const cruising = this.#cruiseOnce(tree);
    this.#violationsByTree.set(tree, cruising);
    return cruising;
  }

  /** The directories planted since the last removal, and still on disk. */
  public get plantedRoots(): readonly string[] {
    return [...this.#plantedRoots];
  }

  /** Every directory this cache has removed, for the case that asserts they are gone. */
  public get removedRoots(): readonly string[] {
    return [...this.#removedRoots];
  }

  /** How many trees have been cruised, for the control that no tree is cruised twice. */
  public get cruisedTreeCount(): number {
    return this.#violationsByTree.size;
  }

  /** Remove every directory planted so far, keeping the results read out of them. */
  public async removePlantedTrees(): Promise<void> {
    const planted = this.#plantedRoots;
    this.#plantedRoots = [];
    this.#removedRoots = [...this.#removedRoots, ...planted];
    await Promise.all(planted.map((root) => rm(root, { recursive: true, force: true })));
  }

  async #plant(tree: PlantedTree): Promise<string> {
    // `realpath` is load-bearing on macOS, where `tmpdir()` is `/var/folders/…`, a symlink
    // to `/private/var/…`: dependency-cruiser resolves modules to their real paths, so a
    // `baseDir` on the symlinked side leaves every module absolute and outside it, and every
    // path-anchored rule silently matches nothing. Measured — without it all four cases
    // report zero violations, including the two that must fail.
    const plantRoot = await realpath(await mkdtemp(join(tmpdir(), "console-layering-")));
    this.#plantedRoots.push(plantRoot);
    for (const [relativePath, contents] of Object.entries(tree)) {
      const absolutePath = join(plantRoot, CONSOLE_ROOT, relativePath);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, contents, "utf8");
    }
    return plantRoot;
  }

  /**
   * Run the REAL rule set over the planted tree and report which rules fired, on which edge.
   *
   * `baseDir` is the only thing that differs from a `pnpm structure:layering` run; the
   * forbidden set, the resolver extensions, and the test-file exclusion all come out of
   * the config file itself.
   */
  async #cruiseOnce(tree: PlantedTree): Promise<readonly string[]> {
    const plantRoot = await this.#plant(tree);
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
}

describe("console layering rules", () => {
  const cruiseCache = new PlantedTreeCache();

  // THE DIRECTORY GOES AND THE RESULT STAYS. A tree is finished the instant the cruise
  // that read it settles, so it is removed here rather than at the suite's end — where
  // every tree would sit on disk for the whole run and all of them would be leaked by a
  // worker that exits before teardown. The cache holds cruise OUTPUTS, which is what a
  // later case reads; no case reads a planted path.
  afterEach(async () => {
    await cruiseCache.removePlantedTrees();
  });

  it(
    "passes the shape the console ships",
    async () => {
      expect(await cruiseCache.violationsFor(CLEAN_TREE)).toEqual([]);
    },
    ONE_TREE_MS,
  );

  it(
    "fails a family door that re-exports through a sub-module door",
    async () => {
      expect(await cruiseCache.violationsFor(BARREL_CHAIN_TREE)).toEqual([
        `${BARREL_CHAIN_RULE}: ${join(CONSOLE_ROOT, "bridge/index.ts")} → ${join(CONSOLE_ROOT, "bridge/growth-values/index.ts")}`,
      ]);
    },
    ONE_TREE_MS,
  );

  it(
    "fails one view family importing another",
    async () => {
      expect(await cruiseCache.violationsFor(VIEW_FAMILY_EDGE_TREE)).toEqual([
        `${VIEW_FAMILY_ISOLATION_RULE}: ${join(CONSOLE_ROOT, "collaboration/SentInvites.ts")} → ${join(CONSOLE_ROOT, "repos/index.ts")}`,
      ]);
    },
    ONE_TREE_MS,
  );

  it(
    "fails a cross-family import that names a module instead of the family door",
    async () => {
      expect(await cruiseCache.violationsFor(DEEP_IMPORT_TREE)).toEqual([
        `${DEEP_IMPORT_RULE}: ${join(CONSOLE_ROOT, "collaboration/SentInvites.ts")} → ${join(CONSOLE_ROOT, "frame/session-lifecycle.ts")}`,
      ]);
    },
    ONE_TREE_MS,
  );

  it(
    "fails a sub-module door reached from outside its own family",
    async () => {
      expect(await cruiseCache.violationsFor(SUB_MODULE_DOOR_TREE)).toEqual([
        `${DEEP_IMPORT_RULE}: ${join(CONSOLE_ROOT, "repos/RepoList.ts")} → ${join(CONSOLE_ROOT, "bridge/growth-values/index.ts")}`,
      ]);
    },
    ONE_TREE_MS,
  );

  it(
    "fails a pane body parked under the composition site",
    async () => {
      expect(await cruiseCache.violationsFor(NESTED_PANE_BODY_TREE)).toEqual([
        `${FLAT_PANE_BOARD_RULE}: ${join(CONSOLE_ROOT, "panes/workflow-run/WorkflowRunPane.ts")} → ${join(CONSOLE_ROOT, "seats/index.ts")}`,
      ]);
    },
    ONE_TREE_MS,
  );

  it(
    "fails the pane board reaching past a family door",
    async () => {
      expect(await cruiseCache.violationsFor(PANE_BOARD_DEEP_IMPORT_TREE)).toEqual([
        `${DEEP_IMPORT_RULE}: ${join(CONSOLE_ROOT, "panes/pane-chrome.ts")} → ${join(CONSOLE_ROOT, "collaboration/SentInvites.ts")}`,
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
      const violationsPerTree = await Promise.all(
        RULE_CONTROL_TREES.map((tree) => cruiseCache.violationsFor(tree)),
      );
      const everyViolation = violationsPerTree.flat();
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
      const first = cruiseCache.violationsFor(CLEAN_TREE);
      expect(cruiseCache.violationsFor(CLEAN_TREE)).toBe(first);
      expect(cruiseCache.cruisedTreeCount).toBeLessThanOrEqual(EVERY_PLANTED_TREE.length);
    },
    ONE_TREE_MS,
  );

  it(
    "plants a tree on disk to cruise it",
    async () => {
      // The other half of the pair below, and the reason it is not vacuous: a case
      // that planted nothing would satisfy "the directory is gone" trivially. This is
      // the case that plants `PROOF_TREE` — no earlier case names it, so the memo
      // cannot answer it — and the tree is on disk while the cruise reads it.
      //
      // EXACTLY ONE outstanding root, which is the per-case claim stated from the
      // planting side: every earlier case's tree went when that case ended, so what is
      // held here is this case's alone.
      expect(await cruiseCache.violationsFor(PROOF_TREE)).toEqual([]);
      expect(cruiseCache.plantedRoots).toHaveLength(1);
      expect(cruiseCache.plantedRoots.every((root) => existsSync(root))).toBe(true);
    },
    ONE_TREE_MS,
  );

  it(
    "has removed every planted tree by the case after the one that planted it",
    async () => {
      // The cleanup claim, observed from OUTSIDE the case that planted — which is the
      // only place an `afterEach` is observable at all. Every tree this suite has
      // planted, not just the last one, so a removal that missed a case is a failure
      // here rather than a directory nobody looks at again.
      expect(cruiseCache.removedRoots.length).toBeGreaterThan(0);
      expect(cruiseCache.removedRoots.filter((root) => existsSync(root))).toEqual([]);
      // And the result outlived its directory: the cached cruise is served without
      // planting anything, which is the whole reason the two lifetimes are separate.
      expect(await cruiseCache.violationsFor(PROOF_TREE)).toEqual([]);
      expect(cruiseCache.plantedRoots).toEqual([]);
    },
    ONE_TREE_MS,
  );
});
