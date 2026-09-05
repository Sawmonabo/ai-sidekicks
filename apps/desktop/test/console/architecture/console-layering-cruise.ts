// One cruise of one planted tree, paid for once — the machinery the cases run on.
//
// The seam is `barrel-census.ts`'s, taken twice: the SUBJECTS are
// `console-layering-trees.ts`, the MACHINERY is here, and
// `console-layering-rules.test.ts` beside them is the suite that judges. What each
// module holds is what a reader has to load to change it — a tree, a budget, or a
// claim — and holding all three at once was a file no reader could keep in view.
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
// rather than a literal chosen to be comfortable. The RULE SET is memoized on the
// same reasoning and for a cost that is not the tree's at all: extracting the config
// resolves and imports the real `.dependency-cruiser.mjs` through the CLI's loader,
// so a load per cruise charged every tree for the same module load.

import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cruise } from "dependency-cruiser";
import extractDepcruiseConfig from "dependency-cruiser/config-utl/extract-depcruise-config";

import { MINIMUM_SETTLEMENT_RESIDUAL_MS } from "../launch-deadline.js";
import { type PlantedTree } from "./console-layering-trees.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..", "..", "..");
const CONFIG_PATH = resolve(PACKAGE_ROOT, ".dependency-cruiser.mjs");

/** Where the rules are anchored, relative to the package root they are run from. */
export const CONSOLE_ROOT: string = join("src", "renderer", "src", "console");

/** The rule names this tier owns. Everything else the cruise reports is another test's. */
export const BARREL_CHAIN_RULE = "console-no-barrel-chain";
export const VIEW_FAMILY_ISOLATION_RULE = "console-view-family-isolation";
export const DEEP_IMPORT_RULE = "console-cross-family-deep-import";
export const PANE_BODY_RULE = "console-panes-hold-no-body";
export const IMPORTED_PANE_BODY_RULE = "console-panes-hold-no-imported-body";
const OWNED_RULES: readonly string[] = [
  BARREL_CHAIN_RULE,
  VIEW_FAMILY_ISOLATION_RULE,
  DEEP_IMPORT_RULE,
  PANE_BODY_RULE,
  IMPORTED_PANE_BODY_RULE,
];

/**
 * What one cruise of a planted tree may cost, in milliseconds.
 *
 * A CEILING FOR A WEDGED CRUISE, not an expectation, on the same posture the launch
 * budgets take: what it guards is a cruise that never settles, so what matters is
 * that some finite figure is enforced and that a case which overruns it says which
 * cruise it was rather than taking vitest's undiagnosable kill.
 *
 * Measured rather than chosen, and re-measured whenever the planted set moves. On an
 * idle eight-core Apple-silicon host one cruise settles in 30-210 ms and the whole
 * file in 342-987 ms of test time over three runs. Ten seconds is roughly two orders
 * of magnitude over the slowest cruise, which is the margin the tier needs: the
 * failure this replaces was not a slow cruise but a cruise queued behind twenty-eight
 * other architecture files under the pool's default parallelism, where what a case
 * waits out is contention rather than work.
 *
 * It is a constant here rather than a `budgets.json` row for the reason that registry
 * states about `MINIMUM_SETTLEMENT_RESIDUAL_MS`: the rows there are the slices of the
 * ONE launch-tier timeout, a set claim their derivation makes explicitly, and this
 * tier launches nothing.
 */
const CRUISE_ALLOWANCE_MS = 10_000;

/** What a case may spend, given how many cruises it can be the first to reach. */
export function layeringTimeoutFor(cruises: number): number {
  return cruises * CRUISE_ALLOWANCE_MS + MINIMUM_SETTLEMENT_RESIDUAL_MS;
}

/** What the config loader answers, named so the memo below can hold its promise. */
type LayeringConfiguration = Awaited<ReturnType<typeof extractDepcruiseConfig>>;

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
export class PlantedTreeCache {
  readonly #violationsByTree = new Map<PlantedTree, Promise<readonly string[]>>();
  #plantedRoots: string[] = [];
  #removedRoots: string[] = [];
  // The rule set, loaded ONCE for the file rather than once per cruise. Extracting it
  // resolves and imports `.dependency-cruiser.mjs` through the same loader the CLI
  // uses, which is a real module load and has nothing to do with the tree being
  // cruised — so a file paid for one identical load per tree it cruised, and each
  // landed inside the per-case budget of whichever case reached a tree first.
  // Held as the PROMISE rather than the value so two cases racing for it still load
  // once, exactly as the cruise results above are.
  #configuration: Promise<LayeringConfiguration> | undefined = undefined;
  #configurationLoadCount = 0;

  /** The rule set every cruise runs, loaded on first use and remembered. */
  #configurationOnce(): Promise<LayeringConfiguration> {
    if (this.#configuration === undefined) {
      this.#configurationLoadCount += 1;
      this.#configuration = extractDepcruiseConfig(CONFIG_PATH);
    }
    return this.#configuration;
  }

  /** How many times the rule set has been loaded, for the control that it is once. */
  public get configurationLoadCount(): number {
    return this.#configurationLoadCount;
  }

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
    const configuration = await this.#configurationOnce();
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
