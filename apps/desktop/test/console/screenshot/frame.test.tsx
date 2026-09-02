// The screenshot tier: the frame and the first-run scenario, per scheme.
//
// `Spec-023 §Console Test Tiers` names a screenshot tier "per component and per
// scheme". Vitest 4's `toMatchScreenshot` owns the baseline: the first run on a
// given browser-and-platform WRITES the reference and passes, and every later run
// compares against it.
//
// That first-run-writes behaviour is the honest limit of this tier and is stated
// here rather than discovered later. Baselines are keyed by platform, so the
// macOS references an author generates are not the references CI compares — CI
// generates its own on its first green run, and only from its SECOND run onward is
// this tier a gate there. Font rasterisation differs enough between the two that
// sharing a baseline would produce a permanently red tier, which is worse than a
// tier that arms one run late. `Spec-023`'s budgets are enforced by the bundle
// tier, which needs no baseline at all, so nothing load-bearing waits on this.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emulateSystemScheme, pressKeys, renderSettled } from "../console-harness.js";

import {
  ConsoleRoot,
  installMeridianTokens,
} from "../../../src/renderer/src/console/frame/index.js";
import { FIRST_RUN_SCENARIO_ID } from "../../../src/renderer/src/console/bridge/scenarios/first-run.js";
import { CONSOLE_SCHEMES } from "../../../src/renderer/src/console/tokens/index.js";

beforeEach(() => {
  document.location.hash = "";
  installMeridianTokens(document);
});

afterEach(async () => {
  // Leave the emulation off, so a later file's baseline is not captured under
  // whichever scheme this one finished in.
  await emulateSystemScheme("light");
});

describe("screenshot — the frame under the first-run scenario", () => {
  for (const scheme of CONSOLE_SCHEMES) {
    it(`renders the ${scheme} scheme`, async () => {
      await emulateSystemScheme(scheme);
      const { container } = await renderSettled(<ConsoleRoot scenarioId={FIRST_RUN_SCENARIO_ID} />);

      const frame = container.querySelector(".meridian-frame");
      expect(frame).not.toBeNull();
      if (frame === null) {
        return;
      }
      await expect(frame).toMatchScreenshot(`frame-first-run-${scheme}`);
    });
  }

  it("renders the palette over the frame", async () => {
    // The palette is the one surface that exists on a first run, so it is the one
    // composition worth pinning before the families ship theirs: the scoped
    // context row, the grouped command list, and the chord hints in the footer.
    await emulateSystemScheme("light");
    const { container } = await renderSettled(<ConsoleRoot scenarioId={FIRST_RUN_SCENARIO_ID} />);
    await pressKeys("{Control>}k{/Control}");
    await pressKeys("{Meta>}k{/Meta}");

    const frame = container.querySelector(".meridian-frame");
    expect(document.querySelector("[role='dialog']")).not.toBeNull();
    expect(frame).not.toBeNull();
    if (frame === null) {
      return;
    }
    // The whole body, not the frame: the palette portals out of the frame's
    // subtree into the overlay root, so a frame-scoped shot would miss it.
    await expect(document.body).toMatchScreenshot("palette-open-light");
  });
});
