// The fixture launch's composition: which scenario a window plays, and the handles a test
// driver reads off the page. The main process has already checked the launch against the
// catalog, so a scenario or session named here exists.

import {
  registerAccountsFixtureBody,
  registerMcpFixtureBody,
} from "#renderer/features/settings/index.js";
import { paneRegistry } from "#renderer/registries/panes/registry.js";
import { screenRegistry } from "#renderer/registries/screens/registry.js";
import { windowTripwires } from "#renderer/lib/tripwires/registry.js";
import { formatRoute } from "#renderer/routing/routes.js";
import { ScenarioFixtureControl } from "#renderer/services/daemon/selection.fixture.js";
import type { BridgeComposition } from "#renderer/services/platform/bridge-context.js";
import { readFixtureLaunch } from "#renderer/services/platform/live-bridge.js";
import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";
import { findScenario } from "#fixtures/index.js";
import {
  SCENARIO_FIXTURE_GLOBAL,
  SESSION_DIAGNOSTICS_FIXTURE_GLOBAL,
  TRIPWIRE_FIXTURE_GLOBAL,
} from "./global-names.js";
import { registerPaneHarnessScreen } from "../pane-harness/register-screen.js";

/**
 * The composition this window's launch asks for, or `undefined` for a normal launch.
 *
 * A launch that names a session opens it by writing the address before the first render. A
 * fixture launch also registers the pane harness, the screen the endurance tier mounts a
 * registered pane body through, and the MCP servers and Providers pages' fixture bodies, which
 * read and send through the scenario's scripted replies.
 */
export function composeFixtureLaunch(): BridgeComposition | undefined {
  const launch = readFixtureLaunch();
  if (launch === undefined) {
    return undefined;
  }
  if (launch.sessionId !== undefined) {
    history.replaceState(null, "", formatRoute({ kind: "session", sessionId: launch.sessionId }));
  }
  registerPaneHarnessScreen(screenRegistry, paneRegistry);
  registerMcpFixtureBody();
  registerAccountsFixtureBody();
  return createFixtureComposition(launch.scenarioId);
}

/**
 * A composition playing one scenario from the catalog.
 *
 * Each bridge runs on its scenario engine's frozen clock; the engine is what the provider
 * disposes and the page's scenario control drives.
 *
 * A removal deletes its page property only while it still holds what this install wrote:
 * several consoles mount into one document in the browser tiers, and an earlier window's
 * teardown must not strip a later window's handle.
 */
export function createFixtureComposition(scenarioId: string): BridgeComposition {
  const scenario = findScenario(scenarioId);
  const page = globalThis as unknown as Record<string, unknown>;
  return {
    createBridge: () => {
      const { bridge, scenarioEngine } = createFixtureBridge({ scenario });
      return {
        bridge,
        clock: scenarioEngine.clock,
        disposal: scenarioEngine,
        installHandles: () => {
          const removeTripwires = hangOnPage(page, TRIPWIRE_FIXTURE_GLOBAL, windowTripwires);
          const removeScenarioControl = hangOnPage(
            page,
            SCENARIO_FIXTURE_GLOBAL,
            new ScenarioFixtureControl(scenarioEngine),
          );
          return () => {
            removeScenarioControl();
            removeTripwires();
          };
        },
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
