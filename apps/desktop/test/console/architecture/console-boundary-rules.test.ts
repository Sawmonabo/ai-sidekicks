// The rules about the console's BOUNDARY with the rest of the package.
//
// Three claims, and one shape between them: an edge whose other end is outside the
// console's own DAG. Who outside the console may reach in, and how far
// (`renderer-reaches-console-through-doors`); what a module that ships may import,
// which is where the two `.test-support` source subtractions stop being safe
// (`test-support-has-no-shipping-reader`); and what a view family may reach out to,
// where `src/shared/` sits on no rung of the ladder at all
// (`console-view-family-shared-through-core`).
//
// The family DAG's own rules — the ordering, the doors, the sibling isolation, the
// composition root — are `console-layering-rules.test.ts` beside this file, with the
// memo and cleanup controls the cruise machinery needs. Both files plant from
// `console-layering-trees.ts` and cruise through `console-layering-cruise.ts`, so a
// rule is stated in `.dependency-cruiser.mjs` and nowhere else; what each file holds
// is the claim. Vitest gives each file its own module registry, so each pays for its
// own cruises — which is the price of two readable files and is what the budget below
// is written against.

import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CONSOLE_ROOT,
  OUTSIDE_DOOR_RULE,
  PlantedTreeCache,
  SHARED_THROUGH_CORE_RULE,
  TEST_SUPPORT_READER_RULE,
  layeringTimeoutFor,
} from "./console-layering-cruise.js";
import {
  OUTSIDE_RENDERER_TREE,
  SHIPPING_TEST_SUPPORT_TREE,
  VIEW_FAMILY_SHARED_TREE,
} from "./console-layering-trees.js";

/** What a case naming ONE tree may spend. */
const ONE_TREE_MS = layeringTimeoutFor(1);

describe("console boundary rules", () => {
  const cruiseCache = new PlantedTreeCache();

  // The same discipline the sibling file states: a tree is finished the instant the
  // cruise that read it settles, so it is removed per case rather than at the suite's
  // end, and what a later case reads is the cached OUTPUT.
  afterEach(async () => {
    await cruiseCache.removePlantedTrees();
  });

  it(
    "fails a renderer subtree outside the console that reaches past a door",
    async () => {
      // The rule every other one here is blind to: they are all `from`-scoped to
      // `console/`, so an importer beside the console matches none of them. The sibling
      // that imports the DOOR is planted in the same tree and must not be reported, and
      // neither is a `.test-support` module writing the OFFENDING edge — the
      // subtraction's own control, on the same shape as the deep-import rule's: the
      // exact list below is what a widened pattern cannot produce, because exempting one
      // more module empties it and exempting one fewer lengthens it.
      //
      // Proved fail-first by removing the `pathNot` from
      // `renderer-reaches-console-through-doors`: the harness line joins the list and
      // this case fails naming `session-bootstrap/seeded.test-support.ts`.
      const outside = join("src", "renderer", "src", "session-bootstrap", "SessionBootstrap.ts");
      const harness = join("src", "renderer", "src", "session-bootstrap", "seeded.test-support.ts");
      const through = join("src", "renderer", "src", "session-members", "SessionMembers.ts");
      const violations = await cruiseCache.violationsFor(OUTSIDE_RENDERER_TREE);

      expect(violations).toEqual([
        `${OUTSIDE_DOOR_RULE}: ${outside} → ${join(CONSOLE_ROOT, "frame/session-lifecycle.ts")}`,
      ]);
      expect(violations.filter((line) => line.includes(harness))).toEqual([]);
      expect(violations.filter((line) => line.includes(through))).toEqual([]);
    },
    ONE_TREE_MS,
  );

  it(
    "fails a module that ships and imports a harness, and not the harness that does",
    async () => {
      // WHAT MAKES THE TWO SOURCE SUBTRACTIONS SAFE. `.test-support.*` is subtracted
      // from the door rule and from the outside-the-console rule, so a module that
      // ships and imports a harness reaches whatever that harness reaches with
      // neither reporting it — and until this rule nothing forbade the edge. Both
      // modules write it and only the one that ships is reported, which a rule with
      // no `from.pathNot` cannot produce.
      const violations = await cruiseCache.violationsFor(SHIPPING_TEST_SUPPORT_TREE);
      const harness = join(CONSOLE_ROOT, "store/settle.test-support.ts");
      const ships = join(CONSOLE_ROOT, "store/session-directory-store.ts");
      expect(violations).toEqual([`${TEST_SUPPORT_READER_RULE}: ${ships} → ${harness}`]);
      expect(violations.filter((line) => line.includes("seeded.test-support"))).toEqual([]);
    },
    ONE_TREE_MS,
  );

  it(
    "fails a view family that reaches the cross-process leaf directly",
    async () => {
      // `src/shared/` is not a console family and sits on no rung of the DAG, so every
      // ordering rule is silent about it and a view family could hold a second reading
      // of a shared shape with the whole gate green. The layer family beside it writes
      // the identical edge and is the legal shape, so a rule scoped one character wider
      // takes its violation too and empties the second expectation.
      const violations = await cruiseCache.violationsFor(VIEW_FAMILY_SHARED_TREE);
      const shared = join("src", "shared", "wire-errors.ts");
      const viewFamily = join(CONSOLE_ROOT, "repos/RepoList.ts");
      const layerFamily = join(CONSOLE_ROOT, "core/wire-rejection.ts");

      expect(violations).toEqual([`${SHARED_THROUGH_CORE_RULE}: ${viewFamily} → ${shared}`]);
      expect(violations.filter((line) => line.includes(layerFamily))).toEqual([]);
    },
    ONE_TREE_MS,
  );
});
