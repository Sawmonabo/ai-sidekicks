// The accessibility tier over the preview pane's chrome, scoped to the pane so a violation names it.
//
// Both schemes: contrast is the rule most likely to pass in one and fail in the other.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emulateSystemScheme } from "../helpers/app-harness.js";
import { mountPreviewPane } from "../helpers/feature-mounts/preview.js";
import {
  PLANTED_VIOLATION_RULE_ID,
  describeViolations,
  plantAxeViolation,
  runTierAxe,
} from "./axe-run.js";

import { installMeridianTokens } from "@renderer/console/frame/index.js";
import { CONSOLE_SCHEMES } from "@renderer/styles/tokens.js";

beforeEach(() => {
  document.location.hash = "";
  installMeridianTokens(document);
});

afterEach(async () => {
  await emulateSystemScheme("light");
});

describe("accessibility — the preview pane", () => {
  for (const scheme of CONSOLE_SCHEMES) {
    it(`has no axe violation on the preview pane's chrome in the ${scheme} scheme`, async () => {
      await emulateSystemScheme(scheme);
      const mounted = await mountPreviewPane();

      expect(describeViolations(await runTierAxe(mounted.element))).toStrictEqual([]);
    });
  }

  it("finds a planted violation, so a clean result means something", async () => {
    // A misconfigured run returns the same empty list the cases above expect.
    const planted = plantAxeViolation();
    try {
      const violations = await runTierAxe(planted);
      expect(violations.map((violation) => violation.id)).toContain(PLANTED_VIOLATION_RULE_ID);
    } finally {
      planted.remove();
    }
  });
});
