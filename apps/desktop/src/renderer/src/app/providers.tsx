// The provider stack every window mounts through, and the composition that has to happen
// before any window renders.
//
// Composition runs at module scope, here, so "a window exists" and "its features are
// composed" are one fact: a screen resolves the registry during render, and an effect
// would run after the first paint had already said the screen does not exist. The
// registries are named here, so a test or another window composes into registries of its own.
// The projector registry is filled before the window opens its first session store, so
// a store folds with every claimed event kind from its first event.
//
// The tripwire route is armed first: a registrar can report during composition (a
// second owner on one slot, a colliding projector claim), and a route armed below
// would record none of those breaches.

import { DesktopBridgeProvider } from "@renderer/services/platform/PlatformBridgeProvider.js";
import type { BridgeComposition } from "@renderer/services/platform/bridge-context.js";
import { RealClock } from "@renderer/lib/clock.js";
import { routeConsoleTripwiresToDiagnosticCapture } from "@renderer/lib/diagnostic-capture/tripwire-diagnostic-route.js";
import { ForwardingConsoleClock } from "@renderer/lib/forwarding-clock.js";
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
 * One identity, rebound: the route is armed before any bridge resolves, and the
 * provider below rebinds it to the window's clock, so under a fixture a tripwire
 * record carries the scenario's frozen time like every other timestamp in the window.
 * Nothing restores wall time on unmount: a breach during teardown belongs to that
 * window's timeline.
 */
const consoleTripwireRouteClock = new ForwardingConsoleClock(new RealClock());

// The route lives as long as the renderer process, so its detach is dropped.
routeConsoleTripwiresToDiagnosticCapture(consoleTripwireRouteClock);

registerFeatureContributions({
  commands: commandContributionRegistry,
  projectors: entityProjectorRegistry,
  surfaces: screenRegistry,
  panes: paneRegistry,
  inlineCards: inlineCardRegistry,
});

/** What the root hands the provider stack. */
export interface AppProvidersProps {
  /** How to build the bridge. Absent, the window reads the preload. */
  readonly composition?: BridgeComposition;
}

/** The provider stack: the platform bridge, then the window. `App.tsx` renders exactly this. */
export function AppProviders(props: AppProvidersProps): React.JSX.Element {
  return (
    <DesktopBridgeProvider
      {...(props.composition === undefined ? {} : { composition: props.composition })}
      clockToRebind={consoleTripwireRouteClock}
    >
      <AppBootstrap />
    </DesktopBridgeProvider>
  );
}
