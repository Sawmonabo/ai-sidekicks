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

// Every deferred body the process-wide pane and screen registries hold loads here, while the
// suite's modules load, so a mount finds each in hand. A loader-backed body arrives on its own
// chunk, which a dynamic import can take longer than the one macrotask a render settle crosses, so
// a tier at a deferred address would read or audit the reserved region; and on a loaded machine
// the chunks take seconds to transform, which inside a test would count against its timeout. The
// registries are full by now: importing `AppProviders` composed every feature into them. A feature
// mount builds its own registry and resolves one body through
// `accessibility/feature-mounts/pane-body-resolution.ts`.
await Promise.all([
  ...paneRegistry.registeredPaneKinds().map(async (kind) => paneRegistry.preload(kind)),
  ...screenRegistry
    .registeredScreenNames()
    .map(async (screenName) => screenRegistry.preload(screenName)),
]);

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
  grantNoIdleTimeWithoutIdleCallbacks();
  await renderSettled(<AppProviders composition={composition} openWindow={frames.open} />);
  return frames.windowNamed(FIXTURE_WINDOW_ID);
}

/**
 * Stands in for the idle callback happy-dom lacks with one that never fires, as on a page that
 * grants no idle time, until the test finishes. The app asks for one after its first frame to warm
 * the diagram label faces, which needs a canvas happy-dom does not have either; a tier on a real
 * browser keeps its own.
 */
function grantNoIdleTimeWithoutIdleCallbacks(): void {
  if ("requestIdleCallback" in globalThis) {
    return;
  }
  Object.assign(globalThis, { requestIdleCallback: () => 0 });
  onTestFinished(() => {
    Reflect.deleteProperty(globalThis, "requestIdleCallback");
  });
}
