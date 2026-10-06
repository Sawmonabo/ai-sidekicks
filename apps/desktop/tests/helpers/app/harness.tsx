// The one app mount, for the renderer, browser and accessibility tiers.
//
// Every mount settles first: `AppProviders` upgrades the store to the durable adapter after mount,
// so asserting straight after `render` hits a half-settled tree.

import { act, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { onTestFinished } from "vitest";

import { AppProviders } from "#renderer/app/AppProviders.js";
import { createFixtureComposition } from "#renderer/app/fixture/composition.js";
import type { BridgeComposition } from "#renderer/services/platform/bridge-context.js";
import { FIXTURE_WINDOW_ID } from "#renderer/services/platform/bridge.fixture.js";
import { FrameWindows } from "../frame-windows.js";
import { crossMacrotaskBoundary } from "../macrotask-boundary.js";
import { paneRegistry } from "#renderer/registries/panes/registry.js";
import { screenRegistry } from "#renderer/registries/screens/registry.js";

/**
 * Loads every deferred body the process-wide pane and screen registries hold.
 *
 * The mount does this, not the tier: a loader-backed body arrives on its own chunk, which a
 * dynamic import can take longer than the one macrotask a render settle crosses, so a tier at a
 * deferred address would read or audit the reserved region. A feature mount builds its own
 * registry and resolves one body through `accessibility/feature-mounts/pane-body-resolution.ts`.
 *
 * It walks every registered key, not the unloaded ones: mounting is itself an ask, so a tier
 * mounting at a lazy address has React call that loader during the initial render and the key has
 * already left `unloadedKeys()`. `preload` settles at once for a body in hand and joins the
 * in-flight promise for one still arriving.
 */
async function loadRegisteredBodies(): Promise<void> {
  await Promise.all([
    ...paneRegistry.registeredPaneKinds().map(async (kind) => paneRegistry.preload(kind)),
    ...screenRegistry
      .registeredScreenNames()
      .map(async (screenName) => screenRegistry.preload(screenName)),
  ]);
}

/**
 * What a mounted app hands back.
 *
 * Not Testing Library's `RenderResult`: that type is generic in its query set and container, and
 * passing an explicit `container` resolves the query parameter to its bare constraint, so naming
 * it here would export a type no caller's `RenderResult` matches. The tiers use the container
 * and nothing else.
 */
interface AppMount {
  /** The viewport-sized element the app was rendered into. */
  readonly container: HTMLElement;
}

/**
 * Mounts at window size and lets every settled promise land.
 *
 * The container is sized to the viewport: Testing Library's default is an unstyled `div`, and the
 * frame's full-height layout in a shrink-to-fit box lays out at the height of its text, making a
 * geometry assertion measure the wrong box. The wait is a macrotask boundary, not a counted number
 * of flushes: the persistence upgrade resolves a promise whose continuation schedules another, and
 * a chain one link deeper than a count would stop being waited for. It waits on no clock: a view
 * over a fixture scenario schedules its reads on the scenario's frozen clock, which
 * `scheduled-read.ts`'s `settleScheduledRead` advances. A caller holding a bridge settles both
 * (`accessibility/feature-mounts/composer.tsx`); a caller mounting `AppProviders`, which builds its
 * own bridge, has only this.
 */
export async function renderSettled(element: ReactElement): Promise<AppMount> {
  const container: HTMLElement = document.createElement("div");
  container.style.width = "100vw";
  container.style.height = "100vh";
  document.body.append(container);

  await act(async () => {
    render(element, { container });
    await crossMacrotaskBoundary();
    // After the first settle: a registry is populated by the feature modules an importer pulled
    // in, and deferred bodies are worth loading only once something has mounted against them.
    // Nothing follows the join: it awaits every registration's own promise, so the wait is the
    // join, and `act` flushes the reveal those settlements schedule when this scope closes.
    await loadRegisteredBodies();
  });
  return { container };
}

/**
 * Mounts the app playing `scenarioId`, its windows opened as iframes over the whole page into
 * `frames`, which a caller passes to read every window the app opens, and lets every settled
 * promise land; answers the window the app opened first, on the page's address. The windows are
 * removed when the test finishes. A caller standing in for main wraps the scenario's composition
 * through `composition`.
 */
export async function renderAppSettled(
  scenarioId: string,
  frames: FrameWindows = new FrameWindows(),
  composition: BridgeComposition = createFixtureComposition(scenarioId),
): Promise<Window> {
  onTestFinished(() => {
    frames.removeAll();
  });
  await renderSettled(<AppProviders composition={composition} openWindow={frames.open} />);
  return frames.windowNamed(FIXTURE_WINDOW_ID);
}
