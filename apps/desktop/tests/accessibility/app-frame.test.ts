// The accessibility tier over the frame, in both schemes. It asserts on the violation list,
// not a count, so a failure names the rule and the node. Both schemes run because contrast is
// the rule most likely to pass in one and fail in the other, and the unit tier's contrast test
// measures the palette, not the rendered composition.
//
// Each case starts from an empty kept window layout and audits once the app's start has read it
// and kept the window it opened: the start's last state change, which the audit must not race.

import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { renderAppSettled } from "../helpers/app/harness.js";
import { emulateSystemScheme } from "../helpers/media-emulation.js";
import {
  PLANTED_VIOLATION_RULE_ID,
  describeViolations,
  plantAxeViolation,
  runTierAxe,
} from "./axe-run.js";

import { installMeridianTokens } from "#renderer/app/token-installation.js";
import { FIXTURE_WINDOW_ID } from "#renderer/services/platform/bridge.fixture.js";
import { UiStateStore } from "#renderer/store/persistence/ui-state-store.js";
import { keepWindows, readKeptWindows } from "#renderer/store/window/layout/kept.js";
import { FIRST_RUN_SCENARIO_ID } from "#fixtures/scenarios/first-run.js";
import { COLOR_SCHEMES } from "#renderer/styles/tokens.js";

/**
 * Mounts the app playing the first-run scenario and waits until its start has read the kept window
 * layout and kept the window it opened. Through Testing Library's wait, which lets the read's
 * state change render while it waits.
 */
async function renderFrameSettled(): Promise<Window> {
  const appWindow = await renderAppSettled(FIRST_RUN_SCENARIO_ID);
  const uiStateStore = UiStateStore.opening();
  try {
    await waitFor(async () => {
      const keptWindowIds = (await readKeptWindows(uiStateStore)).map(({ windowId }) => windowId);
      expect(keptWindowIds).toContain(FIXTURE_WINDOW_ID);
    });
  } finally {
    await uiStateStore.close();
  }
  return appWindow;
}

beforeEach(async () => {
  document.location.hash = "";
  installMeridianTokens(document);
  const uiStateStore = UiStateStore.opening();
  try {
    await keepWindows(uiStateStore, []);
  } finally {
    await uiStateStore.close();
  }
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
      const appWindow = await renderFrameSettled();

      expect(
        describeViolations(await runTierAxe(appWindow.document.documentElement)),
      ).toStrictEqual([]);
    });
  }

  it("finds a planted violation, so a clean result means something", async () => {
    // Negative control: a misconfigured run (wrong root, wrong tags, a swallowed exception, axe
    // loaded into the wrong window) returns the same empty list the cases above expect, so this
    // proves the run is live in the window the app draws.
    const appWindow = await renderFrameSettled();
    const planted = plantAxeViolation(appWindow.document);
    try {
      const violations = await runTierAxe(planted);
      expect(violations.map((violation) => violation.id)).toContain(PLANTED_VIOLATION_RULE_ID);
    } finally {
      planted.remove();
    }
  });
});
