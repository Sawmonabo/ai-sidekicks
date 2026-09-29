// The accessibility tier over the repos family's two surfaces.
//
// `frame-axe.test.tsx` runs the frame; this file runs what the family mounts INTO
// it, and it runs each surface scoped to itself rather than scanning the document,
// so a violation names the surface that owns it.
//
// Both schemes, for `frame-axe.test.tsx`'s reason: contrast is the rule most likely
// to pass in one and fail in the other, and this family has two surfaces the
// palette tests cannot reach at all — a mount card tinted by its own health verdict,
// and a diff row whose intraline highlight is a tint inside a line of text.
//
// THE DIFF PANE IS THE CASE WORTH HAVING. Its rows are a virtualized grid: the
// scroller carries the row count and each drawn row carries its index, so what a
// person using a screen reader is told about a five-thousand-line change set is a
// claim this tier is exactly the instrument for — and the pane is mounted over a
// parsed model rather than over its absence, so the nodes axe walks are the real
// rows and not an empty-state box.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emulateSystemScheme } from "../../test/console/console-harness.js";
import { mountDiffPane, mountRepoSection } from "../helpers/feature-mounts/repos.js";
import { type MountedFamilySurface } from "../helpers/feature-mounts/mount-queries.js";
import {
  PLANTED_VIOLATION_RULE_ID,
  describeViolations,
  plantAxeViolation,
  runTierAxe,
} from "./axe-run.js";

import { installMeridianTokens } from "@renderer/console/frame/index.js";
import { CONSOLE_SCHEMES } from "@renderer/styles/tokens.js";

/** The surfaces this family ships, each named as a reader would name it. */
const AUDITED_SURFACES: readonly {
  readonly label: string;
  readonly mount: () => Promise<MountedFamilySurface>;
}[] = [
  { label: "the repos section with a degraded mount", mount: mountRepoSection },
  { label: "the diff pane over a parsed change set", mount: mountDiffPane },
];

beforeEach(() => {
  document.location.hash = "";
  installMeridianTokens(document);
});

afterEach(async () => {
  await emulateSystemScheme("light");
});

describe("accessibility — the repos section and diff pane", () => {
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
    // Negative control for this file's own runs: the walks above expect an
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
