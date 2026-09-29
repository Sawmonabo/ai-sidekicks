// The accessibility tier over the terminal pane, scoped to the pane so a violation names it.
//
// Both schemes: contrast is the rule most likely to pass in one and fail in the other.
//
// The terminal is the case worth having: the host names the region and lets xterm.js own
// the live region inside it, and the pane is audited with the emulator's chunk landed, so
// the nodes axe walks are the library's real ones and not a skeleton.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emulateSystemScheme } from "../helpers/app-harness.js";
import { mountTerminalPane } from "../helpers/feature-mounts/terminal.js";
import {
  PLANTED_VIOLATION_RULE_ID,
  describeViolations,
  plantAxeViolation,
  runTierAxe,
} from "./axe-run.js";

import { installMeridianTokens } from "@renderer/app/token-installation.js";
import { COLOR_SCHEMES } from "@renderer/styles/tokens.js";

beforeEach(() => {
  document.location.hash = "";
  installMeridianTokens(document);
});

afterEach(async () => {
  await emulateSystemScheme("light");
});

describe("accessibility — the terminal pane", () => {
  for (const scheme of COLOR_SCHEMES) {
    it(`has no axe violation on the terminal pane in the ${scheme} scheme`, async () => {
      await emulateSystemScheme(scheme);
      const mounted = await mountTerminalPane();

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
