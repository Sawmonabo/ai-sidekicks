// The accessibility tier over every surface the composer family mounts.
//
// `frame-axe.test.tsx` runs the frame; this file runs what the family mounts INTO
// it, and it runs each surface scoped to itself rather than scanning the document,
// so a violation names the surface that owns it.
//
// Both schemes, for `frame-axe.test.tsx`'s reason: contrast is the rule most likely
// to pass in one and fail in the other, and this family renders something the
// palette's own contrast test cannot reach.
//
// THE COMPOSER IS THE CASE WORTH HAVING. It is the one surface in the console that
// is always on screen while a person is typing, and it carries the most controls per
// pixel of anything the family ships. Its addresses differ in which of those are
// offered, so a name or a label lost on one address is invisible on the others.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emulateSystemScheme } from "../../test/console/console-harness.js";
import {
  mountComposerProviderBoundRunning,
  mountComposerProviderBoundWaiting,
  mountComposerSessionDefault,
  type MountedFamilySurface,
} from "../helpers/feature-mounts/composer.js";
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
  { label: "the composer on the session", mount: mountComposerSessionDefault },
  { label: "the composer addressed at a working run", mount: mountComposerProviderBoundRunning },
  { label: "the composer addressed at a waiting run", mount: mountComposerProviderBoundWaiting },
];

beforeEach(() => {
  document.location.hash = "";
  installMeridianTokens(document);
});

afterEach(async () => {
  await emulateSystemScheme("light");
});

describe("accessibility — the composer surfaces", () => {
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
    // Negative control for this file's own runs: every case above expects an
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
