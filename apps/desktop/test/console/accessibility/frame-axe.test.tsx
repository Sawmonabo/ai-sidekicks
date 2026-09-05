// The accessibility tier.
//
// `Spec-023 §Console Test Tiers` names axe-core over every surface in both
// schemes. The run itself — which rule set, which root, and how a violation is
// reported — is `axe-run.ts`', shared with this tier's other files so two
// surfaces are never measured by two instruments and then compared as though the
// results were comparable.
//
// Two things this file is careful about:
//
//   • It asserts on the VIOLATION LIST, not on a count, so a failure names the
//     rule and the node instead of saying a number went up.
//   • It runs both schemes. Contrast is the rule most likely to pass in one and
//     fail in the other, and the unit tier's contrast test measures the palette
//     rather than the rendered composition — a muted label on a tinted card is a
//     pair no token table knows about.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emulateSystemScheme, renderSettled } from "../console-harness.js";
import { describeViolations, runAxe } from "./axe-run.js";

import {
  ConsoleRoot,
  installMeridianTokens,
} from "../../../src/renderer/src/console/frame/index.js";
import { FIRST_RUN_SCENARIO_ID } from "../../../src/renderer/src/console/bridge/scenarios/first-run.js";
import { CONSOLE_SCHEMES } from "../../../src/renderer/src/console/tokens/tokens.js";

beforeEach(() => {
  document.location.hash = "";
  installMeridianTokens(document);
});

afterEach(async () => {
  await emulateSystemScheme("light");
});

describe("accessibility — the frame", () => {
  for (const scheme of CONSOLE_SCHEMES) {
    it(`has no axe violation in the ${scheme} scheme`, async () => {
      // Through the system preference, because `ConsoleRoot` owns the scheme
      // attribute and would overwrite a stamped one on its first paint — which
      // would silently run both cases against the light palette and report the
      // contrast rules as clean in a scheme nobody measured.
      await emulateSystemScheme(scheme);
      const { container } = await renderSettled(<ConsoleRoot scenarioId={FIRST_RUN_SCENARIO_ID} />);

      expect(describeViolations(await runAxe(container))).toStrictEqual([]);
    });
  }

  it("finds a planted violation, so a clean result means something", async () => {
    // Negative control. axe returning nothing is the expected result above, and a
    // misconfigured run (wrong root, wrong tags, an exception swallowed) returns
    // exactly the same nothing. This proves the run is live.
    const planted = document.createElement("div");
    planted.innerHTML = '<img src="data:," />';
    document.body.append(planted);
    try {
      expect((await runAxe(planted)).map((violation) => violation.id)).toContain("image-alt");
    } finally {
      planted.remove();
    }
  });
});
