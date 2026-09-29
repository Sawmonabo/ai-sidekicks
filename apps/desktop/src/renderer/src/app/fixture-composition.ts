// The fixture launch's composition: which scenario a window plays, and the handles a test
// driver reads off the page.
//
// Chosen once, at startup, from the launch the preload exposed. `App.tsx` calls
// `composeFixtureLaunch` behind the fixture define, so a release bundle carries neither this
// module nor a scenario, and nothing else in the renderer asks whether it is playing one.
// The main process has already checked the launch against the catalog, so a scenario or
// session named here exists.

import { paneRegistry, screenRegistry } from "@renderer/console/seats/index.js";
import { consoleTripwires } from "@renderer/lib/tripwires.js";
import { formatRoute } from "@renderer/routing/routes.js";
import { ScenarioFixtureControl } from "@renderer/services/daemon/selection.fixture.js";
import type { BridgeComposition } from "@renderer/services/platform/bridge-context.js";
import { readFixtureLaunch } from "@renderer/services/platform/live-bridge.js";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { findScenario } from "../../../../fixtures/index.js";
import {
  SCENARIO_FIXTURE_GLOBAL,
  SESSION_DIAGNOSTICS_FIXTURE_GLOBAL,
  TRIPWIRE_FIXTURE_GLOBAL,
} from "./fixture-global-names.js";
import { registerPaneHarnessScreen } from "./pane-harness/register-pane-harness-screen.js";

/**
 * The composition this window's launch asks for, or `undefined` for a normal launch.
 *
 * A launch that names a session opens it: the address is written before the first render,
 * so the window store reads it as the window's opening route like any other address. A
 * fixture launch also registers the pane harness, the screen the endurance tier mounts a
 * registered pane body through.
 */
export function composeFixtureLaunch(): BridgeComposition | undefined {
  const launch = readFixtureLaunch();
  if (launch === undefined) {
    return undefined;
  }
  if (launch.sessionId !== undefined) {
    history.replaceState(null, "", formatRoute({ kind: "workspace", sessionId: launch.sessionId }));
  }
  registerPaneHarnessScreen(screenRegistry, paneRegistry);
  return createFixtureComposition(launch.scenarioId);
}

/**
 * A composition playing one scenario from the catalog.
 *
 * Each install writes one page property and returns a removal that deletes it only while it
 * still holds what this install wrote: several consoles mount into one document in the
 * browser tiers, and a later window's install supersedes an earlier one's, so an
 * unconditional delete on the earlier one's teardown would strip the live window's handle.
 */
export function createFixtureComposition(scenarioId: string): BridgeComposition {
  const scenario = findScenario(scenarioId);
  const page = globalThis as unknown as Record<string, unknown>;
  return {
    createBridge: () => createFixtureBridge({ scenario }),
    installBridgeHandles: (bridge) => {
      const removeTripwires = hangOnPage(page, TRIPWIRE_FIXTURE_GLOBAL, consoleTripwires);
      const engine = bridge.scenarioEngine;
      const removeScenarioControl =
        engine === undefined
          ? undefined
          : hangOnPage(page, SCENARIO_FIXTURE_GLOBAL, new ScenarioFixtureControl(engine));
      return () => {
        removeScenarioControl?.();
        removeTripwires();
      };
    },
    installSessionDiagnostics: (diagnostics) =>
      hangOnPage(page, SESSION_DIAGNOSTICS_FIXTURE_GLOBAL, diagnostics),
  };
}

function hangOnPage(page: Record<string, unknown>, name: string, value: unknown): () => void {
  page[name] = value;
  return () => {
    if (page[name] === value) {
      delete page[name];
    }
  };
}
