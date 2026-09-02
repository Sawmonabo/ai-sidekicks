// The accessibility tier over the browser-terminal family's three surfaces.
//
// `frame-axe.test.tsx` runs the frame; this file runs what the family mounts INTO
// it, and it runs each surface scoped to itself rather than scanning the document,
// so a violation names the surface that owns it.
//
// Both schemes, for `frame-axe.test.tsx`'s reason: contrast is the rule most likely
// to pass in one and fail in the other, and this family has two surfaces the palette
// tests cannot reach at all — a tinted refusal-adjacent card, and an emulator grid
// whose colours come from the library rather than from the token table.
//
// THE TERMINAL IS THE CASE WORTH HAVING. `XtermHost` deliberately does not announce
// the grid: xterm.js exposes its rows through its own `aria-live` region with a
// twenty-row flood guard, and the host names the region and lets the emulator own
// what is inside it. That is a claim about a live region this tier is exactly the
// instrument for — and the surface is mounted with the emulator's chunk landed, so
// the nodes axe walks are the library's real ones and not a skeleton.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emulateSystemScheme } from "../console-harness.js";
import {
  mountBrowserCaptureCard,
  mountBrowserPane,
  mountTerminalPane,
  type MountedFamilySurface,
} from "../browser-terminal-surfaces.js";
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
  { label: "the browser pane's chrome", mount: mountBrowserPane },
  { label: "a stored capture card", mount: mountBrowserCaptureCard },
  { label: "the terminal pane on a degraded lease", mount: mountTerminalPane },
];

beforeEach(() => {
  document.location.hash = "";
  installMeridianTokens(document);
});

afterEach(async () => {
  await emulateSystemScheme("light");
});

describe("accessibility — the browser and terminal surfaces", () => {
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
    // Negative control for this file's own runs: the six cases above expect an
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
