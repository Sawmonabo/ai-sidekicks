// The accessibility tier over every surface the composer family mounts.
//
// `frame-axe.test.tsx` runs the frame; this file runs what the family mounts INTO
// it, and it runs each surface scoped to itself rather than scanning the document,
// so a violation names the surface that owns it.
//
// Both schemes, for `frame-axe.test.tsx`'s reason: contrast is the rule most likely
// to pass in one and fail in the other, and this family renders something the
// palette's own contrast test cannot reach — a chip whose tone is chosen from a
// wire state.
//
// THE COMPOSER IS THE CASE WORTH HAVING. It is the one surface in the console that
// is always on screen while a person is typing, and it carries the most controls per
// pixel of anything the family ships: two chips, a growing input, a send router, and
// an accessory rail. Its addresses differ in which of those are offered, so a name
// or a label lost on one address is invisible on the others.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emulateSystemScheme } from "../console-harness.js";
import {
  mountComposerChannelDefault,
  mountComposerProviderBoundRunning,
  mountComposerProviderBoundWaiting,
  mountComposerWithAttachments,
  type MountedFamilySurface,
} from "../surfaces/composer.js";
import {
  PLANTED_VIOLATION_RULE_ID,
  describeViolations,
  plantAxeViolation,
  runTierAxe,
} from "./axe-run.js";

import { installMeridianTokens } from "../../../src/renderer/src/console/frame/index.js";
import { CONSOLE_SCHEMES } from "../../../src/renderer/src/console/tokens/tokens.js";

/** The surfaces this family ships, each named as a reader would name it. */
const AUDITED_SURFACES: readonly {
  readonly label: string;
  readonly mount: () => Promise<MountedFamilySurface>;
}[] = [
  { label: "the composer on the session", mount: mountComposerChannelDefault },
  { label: "the composer addressed at a working run", mount: mountComposerProviderBoundRunning },
  { label: "the composer addressed at a waiting run", mount: mountComposerProviderBoundWaiting },
  // A zone the addresses above never put on screen: the attachment strip is absent
  // while a message carries nothing, so its own label, each chip's progress bar and
  // the refusal a chip renders were reachable by no tier at all.
  { label: "the composer carrying attachments", mount: mountComposerWithAttachments },
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
