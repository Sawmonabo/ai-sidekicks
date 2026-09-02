// The accessibility tier.
//
// `Spec-023 §Console Test Tiers` names axe-core over every surface in both
// schemes. It runs INSIDE the browser-mode page rather than through
// `@axe-core/playwright`, which wants a `@playwright/test` `Page` handle Vitest
// browser mode does not hand out — same engine, same rule set, one less
// indirection. (`axe-core` is MPL-2.0 and is admitted as a never-distributed test
// dependency by ADR-020's Decision Log; it must not reach a shipped bundle, which
// is why it is imported here and nowhere under `src/`.)
//
// Two things this file is careful about:
//
//   • It asserts on the VIOLATION LIST, not on a count, so a failure names the
//     rule and the node instead of saying a number went up.
//   • It runs both schemes. Contrast is the rule most likely to pass in one and
//     fail in the other, and the unit tier's contrast test measures the palette
//     rather than the rendered composition — a muted label on a tinted card is a
//     pair no token table knows about.

import axe, { type Result } from "axe-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emulateSystemScheme, renderSettled } from "../console-harness.js";

import {
  ConsoleRoot,
  installMeridianTokens,
} from "../../../src/renderer/src/console/frame/index.js";
import { FIRST_RUN_SCENARIO_ID } from "../../../src/renderer/src/console/bridge/scenarios/first-run.js";
import { CONSOLE_SCHEMES } from "../../../src/renderer/src/console/tokens/index.js";

/** WCAG 2.2 A + AA, which is the level `Spec-023 §Console Design (Meridian)` rule 3 sets. */
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

function describeViolations(violations: readonly Result[]): string[] {
  return violations.map(
    (violation) =>
      `${violation.id} (${violation.impact ?? "unknown"}): ${violation.nodes
        .map((node) => node.target.join(" "))
        .join(", ")}`,
  );
}

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

      const results = await axe.run(container, { runOnly: { type: "tag", values: AXE_TAGS } });

      expect(describeViolations(results.violations)).toStrictEqual([]);
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
      const results = await axe.run(planted, { runOnly: { type: "tag", values: AXE_TAGS } });
      expect(results.violations.map((violation) => violation.id)).toContain("image-alt");
    } finally {
      planted.remove();
    }
  });
});
