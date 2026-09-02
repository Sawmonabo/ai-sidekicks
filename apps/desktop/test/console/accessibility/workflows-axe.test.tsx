// The accessibility tier over every surface the workflows family registers.
//
// `frame-axe.test.tsx` runs the frame; this file runs what the family mounts INTO
// it, and it runs each surface scoped to itself rather than scanning the document,
// so a violation names the surface that owns it.
//
// EVERY REGISTERED SURFACE, WHICH IS THE WHOLE CLAIM. `registerWorkflowSurfaces`
// claims one rail destination and `registerWorkflowPanes` claims TWO pane kinds, so
// the table below carries three rows. It carried two, and the builder pane was the
// one missing — which made a family-wide tier that could not fail on a regression
// unique to that pane's authoring action, its absence block, or its reserved slots.
//
// Both schemes, for `frame-axe.test.tsx`'s reason: contrast is the rule most likely
// to pass in one and fail in the other, and this family draws four things the
// palette tests cannot reach — a scope line naming a wire identifier beside a quiet
// re-scope control, a scope group whose resolution mark is carried on a row's leading
// edge, a park badge that spends amber on exactly one of its two kinds, and a header
// whose primary action is an inline refusal rather than a button.
//
// THE PARKED RUN IS THE CASE WORTH HAVING. Its badges are the family's only tinted,
// glyph-plus-prose composition, and one of the two carries a formatted clock time
// beside the instant the wire sent — a pair whose accessible reading is the thing
// this tier is the instrument for.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emulateSystemScheme } from "../console-harness.js";
import {
  mountWorkflowBuilderPane,
  mountWorkflowParkedRunPane,
  mountWorkflowsDestination,
  type MountedFamilySurface,
} from "../workflow-surfaces.js";
import {
  PLANTED_VIOLATION_RULE_ID,
  describeViolations,
  plantAxeViolation,
  runTierAxe,
} from "./axe-run.js";

import { installMeridianTokens } from "../../../src/renderer/src/console/frame/index.js";
import { CONSOLE_SCHEMES } from "../../../src/renderer/src/console/tokens/index.js";

/**
 * The surfaces this family ships, each named as a reader would name it.
 *
 * One row per registered surface, and the count is the family's rather than this
 * file's: a pane kind claimed by `registerWorkflowPanes` with no row here is a
 * surface this tier reports clean on without ever having mounted it.
 */
const AUDITED_SURFACES: readonly {
  readonly label: string;
  readonly mount: () => Promise<MountedFamilySurface>;
}[] = [
  { label: "the workflows destination", mount: mountWorkflowsDestination },
  { label: "the run pane on a parked run", mount: mountWorkflowParkedRunPane },
  { label: "the builder pane on a definition", mount: mountWorkflowBuilderPane },
];

beforeEach(() => {
  document.location.hash = "";
  installMeridianTokens(document);
});

afterEach(async () => {
  await emulateSystemScheme("light");
});

describe("accessibility — the workflows surfaces", () => {
  for (const surface of AUDITED_SURFACES) {
    for (const scheme of CONSOLE_SCHEMES) {
      it(`has no axe violation on ${surface.label} in the ${scheme} scheme`, async () => {
        await emulateSystemScheme(scheme);
        const mounted = await surface.mount();

        expect(describeViolations(await runTierAxe(mounted.element))).toStrictEqual([]);
      });
    }
  }

  it("finds a planted violation, so a clean result means something", async () => {
    // Negative control for this file's own runs: the four cases above expect an
    // empty list, and a misconfigured run returns exactly the same empty list.
    const planted = plantAxeViolation();
    try {
      const violations = await runTierAxe(planted);
      expect(violations.map((violation) => violation.id)).toContain(PLANTED_VIOLATION_RULE_ID);
    } finally {
      planted.remove();
    }
  });
});
