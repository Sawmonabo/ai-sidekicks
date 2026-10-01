// The screenshot tier: the frame and the first-run scenario, per scheme. The tier is a local
// capture aid, not a regression gate: every capture is written into the gitignored
// `tests/screenshot/__screenshots__/`, compared against nothing, in no CI job and in no `pnpm
// test` chain. Run `pnpm --filter @ai-sidekicks/desktop run test:screenshot` to look at the
// console without building and launching Electron; images are overwritten on every run. No image
// is versioned because font rasterization moves with the operating system, and a gate that is red
// for a reason the reader must discount stops being read. `settled-capture.ts` still refuses a
// picture of a half-built console: the pending pane body and an element the window cannot hold.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  emulateSystemScheme,
  pressKeys,
  renderSettled,
  resetDurableAppState,
} from "../helpers/app-harness.js";
import { requireCapturedElement } from "./captured-element.js";
import { captureSettled } from "./settled-capture.js";

import { createFixtureComposition } from "@renderer/app/fixture-composition.js";
import { AppProviders } from "@renderer/app/AppProviders.js";
import { installMeridianTokens } from "@renderer/app/token-installation.js";
import { FIRST_RUN_SCENARIO_ID } from "../../fixtures/scenarios/first-run.js";
import { COLOR_SCHEMES } from "@renderer/styles/tokens.js";

/** What the console's outermost mounted element is, and what this file captures. */
const FRAME_SELECTOR = ".meridian-frame";

beforeEach(async () => {
  // The database outlives the file that opened it (browser mode gives every file in a session
  // one origin), so a scheme preference or sidebar arrangement another file persisted would be
  // restored into these mounts.
  await resetDurableAppState();
  document.location.hash = "";
  installMeridianTokens(document);
});

afterEach(async () => {
  // Leave the emulation off so a later file's capture is not taken under this file's last scheme.
  await emulateSystemScheme("light");
});

describe("screenshot — the frame under the first-run scenario", () => {
  for (const scheme of COLOR_SCHEMES) {
    it(`renders the ${scheme} scheme`, async () => {
      await emulateSystemScheme(scheme);
      const { container } = await renderSettled(
        <AppProviders composition={createFixtureComposition(FIRST_RUN_SCENARIO_ID)} />,
      );

      await captureSettled(
        requireCapturedElement(container, FRAME_SELECTOR),
        `frame-first-run-${scheme}`,
      );
    });
  }

  it("renders the palette over the frame", async () => {
    // The palette is the one view that exists on a first run: the scoped context row, the grouped
    // command list and the chord hints in the footer.
    await emulateSystemScheme("light");
    const { container } = await renderSettled(
      <AppProviders composition={createFixtureComposition(FIRST_RUN_SCENARIO_ID)} />,
    );
    await pressKeys("{Control>}{Shift>}p{/Shift}{/Control}");
    await pressKeys("{Meta>}{Shift>}p{/Shift}{/Meta}");

    requireCapturedElement(container, FRAME_SELECTOR);
    expect(document.querySelector("[role='dialog']")).not.toBeNull();
    // The whole body, not the frame: the palette portals out of the frame into the overlay root.
    await captureSettled(document.body, "palette-open-light");
  });
});
