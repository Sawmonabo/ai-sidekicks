// The layering rules over the console's OWN families, and their failing controls.
//
// The rules about the console's boundary with the rest of the package — who outside
// it may reach in, what a module that ships may import, and what a view family may
// reach out to — are `console-boundary-rules.test.ts` beside this file. Two claims,
// two files, one corpus: both read `console-layering-trees.ts` and both cruise
// through `console-layering-cruise.ts`, so neither restates a rule.
//
// `structure:layering` is a command, not a suite: it reports on THIS tree, and a
// tree that happens not to contain a violation reports clean whether the rule
// exists or not. Two rules landed here whose subject does not exist yet — the six
// view families are unlanded branches, and the console carries exactly one
// barrel-to-barrel forward that this same change removed — so without a planted
// control both would have shipped green and unproven. The door rule and the two
// pane-board rules are the same shape for the same reason: the change that added them
// also hoisted or moved every module that violated them, so the tree they land on is
// clean by construction and their green says nothing about whether they bite.
//
// WHAT IS PLANTED AND WHY IT IS NOT A REIMPLEMENTATION. The rule set under test is
// the real `.dependency-cruiser.mjs`, loaded through dependency-cruiser's own
// config loader — the same loader the CLI uses — and run through the real `cruise`.
// Only the SUBJECT is synthetic: a module tree written into a temporary directory
// at the same relative paths the rules are anchored on (`src/renderer/src/console/…`),
// so `baseDir` is the whole of the difference between this run and the CLI's. No
// path regex, family list, or dependency type is restated here. The subjects are
// `console-layering-trees.ts` and the cruise machinery is `console-layering-cruise.ts`,
// both beside this file on the seam `barrel-census.ts` already takes — a tree, a
// budget, and a claim are three things to change and this file holds only the third.
//
// WHY NOT PLANT INTO THE REAL TREE. The aggregate `test` script runs this tier
// alongside `console-unit` in one Turbo batch, so a fixture written under `src/`
// would be visible to a concurrently building sibling; and a crash between the
// write and the delete would leave a violation in the tree that the next
// `structure` run reports as real.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BARREL_CHAIN_RULE,
  CONSOLE_ROOT,
  CONSOLE_ROOT_RULE,
  DEEP_IMPORT_RULE,
  IMPORTED_PANE_BODY_RULE,
  PANE_BODY_RULE,
  PlantedTreeCache,
  STATE_UPWARD_EDGE_RULE,
  VIEW_FAMILY_ISOLATION_RULE,
  layeringTimeoutFor,
} from "./console-layering-cruise.js";
import {
  BARREL_CHAIN_TREE,
  CLEAN_TREE,
  CONSOLE_ROOT_TREE,
  DEEP_IMPORT_TREE,
  DEEP_SOURCE_TREE,
  EVERY_PLANTED_TREE,
  PANE_BOARD_DEEP_IMPORT_TREE,
  PANE_BOARD_SUBDIRECTORY_TREE,
  PROOF_TREE,
  RULE_CONTROL_TREES,
  SUB_MODULE_DOOR_TREE,
  TEST_SUPPORT_SUBTRACTION_TREE,
  TEST_SUPPORT_UPWARD_EDGE_TREE,
  VIEW_FAMILY_EDGE_TREE,
} from "./console-layering-trees.js";

/** What a case naming ONE tree may spend. */
const ONE_TREE_MS = layeringTimeoutFor(1);

/**
 * What the aggregate case may spend: one allowance per tree it NAMES.
 *
 * Not per tree it cruises, which is the few `console-boundary-rules.test.ts` answers
 * rather than this file. Budgeting the names rather than the cruises makes the figure
 * independent of the order the cases run in, and of which file answers which tree,
 * which a budget that assumed a warm memo would not be.
 */
const EVERY_TREE_MS = layeringTimeoutFor(RULE_CONTROL_TREES.length);

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
      // Three edges leave the same file and exactly two are reported: the seats DOOR
      // import is the legal shape and must not be, and the two deep specifiers must
      // be. The `seats/surface-registry.js` one is the claim that the rule's last
      // named exemption is gone — that module was subtracted by name while it lived
      // in `frame/`, and a specifier to it was reported as nothing.
      const source = join(CONSOLE_ROOT, "collaboration/SentInvites.ts");
      const violations = await cruiseCache.violationsFor(DEEP_IMPORT_TREE);

      expect([...violations].sort()).toEqual(
        [
          `${DEEP_IMPORT_RULE}: ${source} → ${join(CONSOLE_ROOT, "frame/session-lifecycle.ts")}`,
          `${DEEP_IMPORT_RULE}: ${source} → ${join(CONSOLE_ROOT, "seats/surface-registry.ts")}`,
        ].sort(),
      );
      expect(violations.filter((line) => line.includes("seats/index.ts"))).toEqual([]);
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
    "fails a pane body parked under the board, from both endpoints",
    async () => {
      // The composer's three pane bodies lived at `panes/runs/`, `panes/approvals/`, and
      // `panes/inspector/` before the rule that every body lives in its own family. The
      // board's own exemption is what made that invisible: `panes/` was subtracted from
      // the view-family set wholesale, so a body under it could import any view family
      // it liked and no rule said a word.
      const body = join(CONSOLE_ROOT, "panes/runs/RunsPaneBody.ts");
      const sibling = join(CONSOLE_ROOT, "repos/RepoList.ts");
      // Sorted, because four rules fire on two edges and the order dependency-cruiser
      // reports them in is its own — asserting it would be asserting the reporter.
      expect([...(await cruiseCache.violationsFor(PANE_BOARD_SUBDIRECTORY_TREE))].sort()).toEqual(
        [
          `${PANE_BODY_RULE}: ${body} → ${sibling}`,
          `${IMPORTED_PANE_BODY_RULE}: ${join(CONSOLE_ROOT, "panes/index.ts")} → ${body}`,
          // The narrowing, witnessed twice: the board's exemption is now the FILES on it,
          // so a body under it is an ordinary view family — its edge into `repos/` is the
          // sibling edge every other family is held to, and its specifier past that
          // family's door is the deep import every other family is held to.
          `${VIEW_FAMILY_ISOLATION_RULE}: ${body} → ${sibling}`,
          `${DEEP_IMPORT_RULE}: ${body} → ${sibling}`,
        ].sort(),
      );
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
      // `panes/index.ts` is the board itself and it imports `seats/index.js` in every tree
      // above. Across every control tree it is named by exactly ONE violation — the
      // imported-body rule's, whose whole point is that the board imported a body that
      // should not exist — and by none for the door edge it is written to carry. That edge
      // is the one the barrel-chain rule would catch if it matched on the module pair
      // rather than on the `export … from` dependency type, and a rule that reported it
      // would make the pane board unwritable. Quantified over `RULE_CONTROL_TREES` so a
      // control added for a further rule joins this claim by construction.
      const violationsPerTree = await Promise.all(
        RULE_CONTROL_TREES.map((tree) => cruiseCache.violationsFor(tree)),
      );
      const board = join(CONSOLE_ROOT, "panes/index.ts");
      expect(violationsPerTree.flat().filter((line) => line.includes(board))).toEqual([
        `${IMPORTED_PANE_BODY_RULE}: ${board} → ${join(CONSOLE_ROOT, "panes/runs/RunsPaneBody.ts")}`,
      ]);
    },
    EVERY_TREE_MS,
  );

  it(
    "fails a deep import written from inside a family's own sub-directory",
    async () => {
      // The production shape this rule was written for, and the one whose SOURCE depth
      // could be got wrong: the rule captures the owning family from the first path
      // segment, so a body two directories in has to resolve to the same owner and be
      // held to the same target set as one at the family root.
      expect(await cruiseCache.violationsFor(DEEP_SOURCE_TREE)).toEqual([
        `${DEEP_IMPORT_RULE}: ${join(CONSOLE_ROOT, "repos/pane/node-presence-model.ts")} → ${join(CONSOLE_ROOT, "bridge/growth-signatures.ts")}`,
      ]);
    },
    ONE_TREE_MS,
  );

  it(
    "exempts a harness from the door rule and nothing else from it",
    async () => {
      // THE SUBTRACTION'S OWN CONTROL, and the one arm of this rule set that had none.
      // Two modules write the SAME edge; only the ordinary one is reported. A pattern
      // widened by a character would exempt both and this case would read an empty list,
      // which is the failure it exists to produce.
      const violations = await cruiseCache.violationsFor(TEST_SUPPORT_SUBTRACTION_TREE);
      const harness = join(CONSOLE_ROOT, "repos/fixtures.test-support.ts");
      const ordinary = join(CONSOLE_ROOT, "repos/RepoList.ts");
      const target = join(CONSOLE_ROOT, "frame/session-lifecycle.ts");

      expect(violations).toContain(`${DEEP_IMPORT_RULE}: ${ordinary} → ${target}`);
      expect(violations.filter((line) => line.includes(harness))).toEqual([]);
    },
    ONE_TREE_MS,
  );

  it(
    "fails a harness that reaches upward across the family DAG",
    async () => {
      // WHERE THE HARNESS EXEMPTION STOPS. The case above proves `.test-support.*` is
      // subtracted from the door rule; this one proves it reaches no further. Both
      // modules write the same edge and BOTH are reported, because a harness reaching
      // for a symbol above its own family is the same inversion an ordinary module's
      // edge is — the remedy is to hoist the symbol, never to exempt the reader.
      //
      // The importer that surfaced this in production was a `.test.tsx`, which
      // `options.exclude` removes from the graph before any rule runs; the harness
      // beside it stays in, which is why this class is the one a planted tree can
      // hold at all.
      //
      // Perturbed by adding `TEST_SUPPORT_MODULES` to `upwardEdge`'s `from.pathNot`:
      // the harness line goes and the ordinary one stays, which is the failure this
      // case exists to produce.
      const violations = await cruiseCache.violationsFor(TEST_SUPPORT_UPWARD_EDGE_TREE);
      const target = join(CONSOLE_ROOT, "bridge/index.ts");

      expect([...violations].sort()).toEqual(
        [
          `${STATE_UPWARD_EDGE_RULE}: ${join(CONSOLE_ROOT, "store/settle.test-support.ts")} → ${target}`,
          `${STATE_UPWARD_EDGE_RULE}: ${join(CONSOLE_ROOT, "store/session-directory-store.ts")} → ${target}`,
        ].sort(),
      );
    },
    ONE_TREE_MS,
  );

  it(
    "fails a console root module that is not an enumerated composition site",
    async () => {
      // The enumeration as a claim rather than as a ban on root files: `families.ts`
      // writes the identical edge from the identical directory and is left alone, so a
      // wildcard restored here would take the rogue module's violation with it.
      const violations = await cruiseCache.violationsFor(CONSOLE_ROOT_TREE);

      expect(violations).toEqual([
        `${CONSOLE_ROOT_RULE}: ${join(CONSOLE_ROOT, "rogue-composition.ts")} → ${join(CONSOLE_ROOT, "repos/index.ts")}`,
      ]);
      expect(violations.filter((line) => line.includes("families.ts"))).toEqual([]);
    },
    ONE_TREE_MS,
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
    "control: the rule set is loaded once, however many trees are cruised",
    async () => {
      // The other half of the memo, and invisible without this: extracting the config
      // resolves and imports the real `.dependency-cruiser.mjs` through the CLI's own
      // loader, which has nothing to do with the tree being cruised — so a load per
      // cruise put that cost inside the budget of whichever case reached a tree first.
      // Asserted after a cruise has been awaited, so a count of zero cannot pass it.
      // Perturbed by unmemoizing: the count reads one per tree cruised.
      await cruiseCache.violationsFor(CLEAN_TREE);
      expect(cruiseCache.cruisedTreeCount).toBeGreaterThan(0);
      expect(cruiseCache.configurationLoadCount).toBe(1);
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
