// The screenshot tier: the frame and the first-run scenario, per scheme.
//
// The screenshot tier captures per component and per scheme, and since 2026-09-09 it is a LOCAL CAPTURE AID rather than a regression
// gate: every capture is written into the gitignored
// `test/console/screenshot/__screenshots__/`, compared against nothing, in no CI job
// and in no `pnpm test` chain. What it still refuses is a capture that would be a
// picture of a half-built console — `settled-capture.ts` holds both refusals, the
// pending pane body and the surface the window cannot hold.
//
// WHY NO IMAGE IS VERSIONED. A reference image is a gate only while the next run
// renders under the same conditions, and font rasterisation moves with the operating
// system: the same three comparisons this tier used to make disagreed by six pixels
// of one keycap glyph on one developer Mac and by four figures on others. A gate that
// is red for a reason the reader must know to discount is a gate the reader stops
// reading, so the comparison is gone and the pictures are what is left.
//
// WHAT THE CAPTURES ARE FOR. Looking at the console without building and launching
// Electron: run
// `pnpm --filter @ai-sidekicks/desktop run test:console-screenshot` and open the
// directory. The images are overwritten on every run and none of them is reviewed,
// committed, or compared.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  emulateSystemScheme,
  pressKeys,
  renderSettled,
  resetDurableConsoleState,
} from "../console-harness.js";
import { requireCapturedElement } from "./captured-element.js";
import { captureSettled } from "./settled-capture.js";

import {
  ConsoleRoot,
  installMeridianTokens,
} from "../../../src/renderer/src/console/frame/index.js";
import { FIRST_RUN_SCENARIO_ID } from "../../../src/renderer/src/console/bridge/scenario/first-run.js";
import { CONSOLE_SCHEMES } from "../../../src/renderer/src/console/tokens/tokens.js";

/** What the console's outermost mounted element is, and what this file captures. */
const FRAME_SELECTOR = ".meridian-frame";

beforeEach(async () => {
  // The database this window opens outlives the file that opened it: browser mode
  // gives every file in a session one origin, so a scheme preference or a sidebar
  // arrangement another file persisted would be restored into these mounts and
  // photographed here.
  await resetDurableConsoleState();
  document.location.hash = "";
  installMeridianTokens(document);
});

afterEach(async () => {
  // Leave the emulation off, so a later file's capture is not taken under
  // whichever scheme this one finished in.
  await emulateSystemScheme("light");
});

describe("screenshot — the frame under the first-run scenario", () => {
  for (const scheme of CONSOLE_SCHEMES) {
    it(`renders the ${scheme} scheme`, async () => {
      await emulateSystemScheme(scheme);
      const { container } = await renderSettled(<ConsoleRoot scenarioId={FIRST_RUN_SCENARIO_ID} />);

      await captureSettled(
        requireCapturedElement(container, FRAME_SELECTOR),
        `frame-first-run-${scheme}`,
      );
    });
  }

  it("renders the palette over the frame", async () => {
    // The palette is the one surface that exists on a first run, so it is the one
    // composition worth capturing before the families ship theirs: the scoped
    // context row, the grouped command list, and the chord hints in the footer.
    await emulateSystemScheme("light");
    const { container } = await renderSettled(<ConsoleRoot scenarioId={FIRST_RUN_SCENARIO_ID} />);
    await pressKeys("{Control>}k{/Control}");
    await pressKeys("{Meta>}k{/Meta}");

    requireCapturedElement(container, FRAME_SELECTOR);
    expect(document.querySelector("[role='dialog']")).not.toBeNull();
    // The whole body, not the frame: the palette portals out of the frame's
    // subtree into the overlay root, so a frame-scoped shot would miss it.
    await captureSettled(document.body, "palette-open-light");
  });
});
