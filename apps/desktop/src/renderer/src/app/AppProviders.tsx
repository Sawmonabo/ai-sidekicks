// The provider stack every window mounts through, and the composition that runs before any
// window renders.
//
// Composition runs at module scope so "a window exists" and "its features are composed" are one
// fact: a screen resolves the registry during render, and an effect would run after first paint.
// The registries are named here so a test or another window composes into registries of its own.
// The tripwire route is armed first because a registrar can report during composition (a second
// owner on one name, a colliding projector claim).

import { PlatformBridgeProvider } from "@renderer/services/platform/PlatformBridgeProvider.js";
import type { BridgeComposition } from "@renderer/services/platform/bridge-context.js";
import { RealClock } from "@renderer/lib/clock.js";
import { routeWindowTripwiresToDiagnosticCapture } from "@renderer/lib/diagnostic-capture/tripwire-diagnostic-route.js";
import { ForwardingClock } from "@renderer/lib/forwarding-clock.js";
import { commandContributionRegistry } from "@renderer/registries/commands/command-contributions.js";
import { entityProjectorRegistry } from "@renderer/registries/entity-projectors/entity-projector-registry.js";
import { inlineCardRegistry } from "@renderer/registries/inline-cards/inline-card-registry.js";
import { paneRegistry } from "@renderer/registries/panes/pane-registry.js";
import { screenRegistry } from "@renderer/registries/screens/screen-registry.js";
import { AppBootstrap } from "./AppBootstrap.js";
import { registerFeatureContributions } from "./registrations.js";

/**
 * The clock the tripwire route stamps its records off.
 *
 * The route is armed before any bridge resolves and the provider rebinds this clock to the
 * window's, so under a fixture a tripwire record carries the scenario's frozen time. Wall time
 * is not restored on unmount: a breach during teardown belongs to that window's timeline.
 */
const tripwireRouteClock = new ForwardingClock(new RealClock());

// The route lives as long as the renderer process, so its detach is dropped.
routeWindowTripwiresToDiagnosticCapture(tripwireRouteClock);

registerFeatureContributions({
  commands: commandContributionRegistry,
  projectors: entityProjectorRegistry,
  screens: screenRegistry,
  panes: paneRegistry,
  inlineCards: inlineCardRegistry,
});

/** What the root hands the provider stack. */
export interface AppProvidersProps {
  /** How to build the bridge. Absent, the window reads the preload. */
  readonly composition?: BridgeComposition;
}

/** The provider stack: the platform bridge, then the window. */
export function AppProviders(props: AppProvidersProps): React.JSX.Element {
  return (
    <PlatformBridgeProvider
      {...(props.composition === undefined ? {} : { composition: props.composition })}
      clockToRebind={tripwireRouteClock}
    >
      <AppBootstrap />
    </PlatformBridgeProvider>
  );
}
