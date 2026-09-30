// The accessibility tier over the frame, in both schemes. It asserts on the violation list,
// not a count, so a failure names the rule and the node. Both schemes run because contrast is
// the rule most likely to pass in one and fail in the other, and the unit tier's contrast test
// measures the palette, not the rendered composition.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emulateSystemScheme, renderSettled } from "../helpers/app-harness.js";
import {
  PLANTED_VIOLATION_RULE_ID,
  describeViolations,
  plantAxeViolation,
  runTierAxe,
} from "./axe-run.js";

import { createFixtureComposition } from "@renderer/app/fixture-composition.js";
import { AppProviders } from "@renderer/app/providers.js";
import { installMeridianTokens } from "@renderer/app/token-installation.js";
import { FIRST_RUN_SCENARIO_ID } from "../../fixtures/scenarios/first-run.js";
import { COLOR_SCHEMES } from "@renderer/styles/tokens.js";

beforeEach(() => {
  document.location.hash = "";
  installMeridianTokens(document);
});

afterEach(async () => {
  await emulateSystemScheme("light");
});

describe("accessibility — the frame", () => {
  for (const scheme of COLOR_SCHEMES) {
    it(`has no axe violation in the ${scheme} scheme`, async () => {
      // Through the system preference, because `AppProviders` owns the scheme attribute and
      // would overwrite a stamped one on its first paint, running both cases against the light
      // palette.
      await emulateSystemScheme(scheme);
      const { container } = await renderSettled(
        <AppProviders composition={createFixtureComposition(FIRST_RUN_SCENARIO_ID)} />,
      );

      expect(describeViolations(await runTierAxe(container))).toStrictEqual([]);
    });
  }

  it("finds a planted violation, so a clean result means something", async () => {
    // Negative control: a misconfigured run (wrong root, wrong tags, a swallowed exception)
    // returns the same empty list the cases above expect, so this proves the run is live.
    const planted = plantAxeViolation();
    try {
      const violations = await runTierAxe(planted);
      expect(violations.map((violation) => violation.id)).toContain(PLANTED_VIOLATION_RULE_ID);
    } finally {
      planted.remove();
    }
  });
});
