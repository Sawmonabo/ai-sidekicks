// The screenshot tier: the session workspace, with its sidebar open and collapsed.
//
// `Spec-023 §Console Test Tiers` names a screenshot tier "per component and per
// scheme", and the workspace is the surface where the sidebar's own claim is
// visible at all: the split between the deck and the column, the eight section
// headers a person reads down, and the rail the collapsed sidebar leaves behind.
// None of that is checkable from the DOM assertions in the unit tier — a sidebar
// rendered at zero width, behind the deck, or with its rail clipped away passes
// every one of them.
//
// TWO SUBJECTS RATHER THAN ONE, and the second is not decoration. Collapsed is the
// state a person leaves the sidebar in for a whole session, and the failure it
// guards against is the one that cannot be asserted: a rail with nothing on it is
// a sidebar there is no way back from.
//
// The tier's fail-closed guard and its missing-reference probe are asserted once
// for the whole tier by `frame.test.tsx`; `baseline-platform.ts` says why they are
// not repeated here.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "@testing-library/react";

import { emulateSystemScheme, renderSettled } from "../console-harness.js";
import {
  OFF_PLATFORM_REASON,
  isOffPinnedPlatform,
  skipOffPinnedPlatform,
} from "./baseline-platform.js";

import {
  ConsoleRoot,
  installMeridianTokens,
} from "../../../src/renderer/src/console/frame/index.js";
import { formatRoute } from "../../../src/renderer/src/console/routing/index.js";
import { CONSOLE_SCHEMES } from "../../../src/renderer/src/console/tokens/tokens.js";
import {
  LEDGER_QUIET_SCENARIO,
  LEDGER_QUIET_SCENARIO_ID,
} from "../../../src/renderer/src/console/bridge/scenarios/ledger-quiet.js";

/**
 * The workspace with its sidebar mounted, or a throw.
 *
 * A throw rather than the assert-then-return-early shape, which turns "the sidebar
 * never mounted" into a test that passes having photographed a deck alone.
 */
async function openWorkspace(): Promise<Element> {
  document.location.hash = formatRoute({
    kind: "workspace",
    sessionId: LEDGER_QUIET_SCENARIO.sessionId,
  });
  const { container } = await renderSettled(<ConsoleRoot scenarioId={LEDGER_QUIET_SCENARIO_ID} />);
  const frame = container.querySelector(".meridian-frame");
  const sidebar = container.querySelector(".meridian-sidebar");
  if (frame === null || sidebar === null) {
    throw new Error(
      "the console rendered no .meridian-frame with a .meridian-sidebar inside it, so there is nothing for this tier to compare",
    );
  }
  return frame;
}

/** Collapse the sidebar the way a person does: the control on the column itself. */
function collapseSidebar(frame: Element): void {
  const control = frame.querySelector<HTMLButtonElement>(".meridian-sidebar__collapse");
  if (control === null) {
    throw new Error(
      "the sidebar rendered no collapse control, so the collapsed subject cannot be reached the way a person reaches it",
    );
  }
  // Inside `act`, because the collapse is a store transition whose commit the capture
  // below reads: outside it the frame is photographed one commit behind the state the
  // reference is named for.
  act(() => {
    control.click();
  });
}

beforeEach(() => {
  document.location.hash = "";
  installMeridianTokens(document);
});

afterEach(async () => {
  document.location.hash = "";
  // Leave the emulation off, so a later file's baseline is not captured under
  // whichever scheme this one finished in.
  await emulateSystemScheme("light");
});

describe("screenshot — the session workspace and its sidebar", () => {
  // Said once at collection, on the one channel the terminal reporter forwards.
  if (isOffPinnedPlatform) {
    console.warn(OFF_PLATFORM_REASON);
  }

  for (const scheme of CONSOLE_SCHEMES) {
    it(`renders the sidebar expanded in the ${scheme} scheme`, async (context) => {
      skipOffPinnedPlatform(context);
      await emulateSystemScheme(scheme);
      const frame = await openWorkspace();

      await expect(frame).toMatchScreenshot(`workspace-sidebar-expanded-${scheme}`);
    });

    it(`renders the sidebar collapsed in the ${scheme} scheme`, async (context) => {
      skipOffPinnedPlatform(context);
      await emulateSystemScheme(scheme);
      const frame = await openWorkspace();
      collapseSidebar(frame);

      await expect(frame).toMatchScreenshot(`workspace-sidebar-collapsed-${scheme}`);
    });
  }
});
