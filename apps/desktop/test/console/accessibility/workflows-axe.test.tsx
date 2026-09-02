// The accessibility tier over the workflows family's two surfaces.
//
// `frame-axe.test.tsx` runs the frame; this file runs what the family mounts INTO
// it, and it runs each surface scoped to itself rather than scanning the document,
// so a violation names the surface that owns it.
//
// Both schemes, for `frame-axe.test.tsx`'s reason: contrast is the rule most likely
// to pass in one and fail in the other, and this family draws two things the palette
// tests cannot reach — a scope group whose resolution mark is carried on a row's
// leading edge, and a park badge that spends amber on exactly one of its two kinds.
//
// THE PARKED RUN IS THE CASE WORTH HAVING. Its badges are the family's only tinted,
// glyph-plus-prose composition, and one of the two carries a formatted clock time
// beside the instant the wire sent — a pair whose accessible reading is the thing
// this tier is the instrument for.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emulateSystemScheme } from "../console-harness.js";
import {
  mountWorkflowDefinitionsBrowser,
  mountWorkflowParkedRunPane,
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

/** The surfaces this family ships, each named as a reader would name it. */
const AUDITED_SURFACES: readonly {
  readonly label: string;
  readonly mount: () => Promise<MountedFamilySurface>;
}[] = [
  { label: "the definitions browser", mount: mountWorkflowDefinitionsBrowser },
  { label: "the run pane on a parked run", mount: mountWorkflowParkedRunPane },
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
