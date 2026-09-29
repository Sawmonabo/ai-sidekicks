// Where the console starts.
//
// The window's entry point: it composes the surface families and hands what it
// built to the bridge provider. Everything else is elsewhere in this family —
// `ConsoleFrameHost.tsx` beside it is the bridge gate and the token sheet above it,
// `ConsoleFrame.tsx` beside it is the window itself, `RouteSurface.tsx` beside it
// resolves a route to a surface, and the command surface, the rail, the session
// registry, the durable store's life and the color scheme are the family root,
// `composition/`, `session/` and `bindings/` between them.
//
// What stays here is the one thing that has to happen before any window renders,
// and the provider that has to wrap every one of them.

import { DesktopBridgeProvider } from "@renderer/console/bridge/BridgeProvider.js";
import { ForwardingConsoleClock } from "@renderer/lib/forwarding-clock.js";
import { RealClock } from "@renderer/lib/clock.js";
import { routeConsoleTripwiresToDiagnosticCapture } from "@renderer/lib/diagnostic-capture/tripwire-diagnostic-route.js";
import { registerConsoleFamilies } from "../../families.js";
import { consoleEntityProjectorRegistry } from "@renderer/registries/entity-projectors/entity-projector-registry.js";
import {
  consolePaneRegistry,
  consoleSurfaceRegistry,
  inlineCardSeatRegistry,
} from "../../seats/index.js";
import { ConsoleFrameHost } from "@renderer/app/AppBootstrap.js";

// Composition, at module scope, before any window renders.
//
// It happens HERE rather than in the renderer entry point because "a console
// window exists" and "its families are composed" have to be the same fact. Every
// window — the main one, an auxiliary one, a test's — mounts through
// `ConsoleRoot`; composed one level up in whatever component the entry point
// happened to render, a window that mounted `ConsoleRoot` by any other path would
// come up against an empty registry and report every route as reserved-not-built,
// which is a wrong answer that looks exactly like a correct one.
//
// Module scope rather than an effect because `RouteSurface` resolves the registry
// during render: an effect runs after the first paint has already said the
// surface does not exist. Registration is idempotent per module graph, and the
// registry refuses a second OWNER on one slot, so a hot reload replaces and a
// collision raises.
//
// The four process-wide boards are named HERE rather than reached for inside the
// composition, which is what makes this the composition site: a test or an auxiliary
// window calls the same function with boards of its own and touches none of these.
//
// The inline-card board is named even though no family fills it yet, and that is the
// reason to name it: it ships a module-scope registrar that writes into the singleton,
// so a family reaching for it would compose into production from inside a composition
// that was handed something else. Passing it here is what makes that reach unnecessary.
//
// The projector board's ORDER against the window below is the reason it is composed at
// module scope with the others: a family claims the event kinds it folds here, and a
// window opens its first session store during render, which is strictly after. A store
// therefore opens with the fold the composition claimed rather than with whatever had
// registered by the time the first event arrived.
//
// The fifth thing composed here is a wire rather than a board — every tripwire this
// process reports reaches the diagnostic capture — and it is armed FIRST, above the
// families. A registrar can report during composition (the boards refuse a second
// owner on one slot, and a projector claim can collide), so a route armed below this
// call would leave exactly the composition-time breaches recorded nowhere.

/**
 * The clock the tripwire route stamps its records off.
 *
 * ONE IDENTITY, REBOUND, RATHER THAN A FRESH `RealClock`. The route is armed before
 * any bridge is resolved, so there is nothing else it could start on; but the console
 * runs on the bridge's clock, which under a fixture is the scenario engine's FROZEN
 * one. A route holding wall time would stamp a tripwire record hours away from the
 * frame it describes, in the one build where every other timestamp in the window is
 * the scenario's — the exact disagreement the route's clock parameter exists to
 * prevent. `ForwardingConsoleClock` is the seam for precisely this: the identity is
 * fixed at arming and the reading is whatever the window's clock is when a record is
 * made, so `DesktopBridgeProvider` hands it the resolved bridge's clock below.
 *
 * NOTHING RESTORES WALL TIME WHEN A WINDOW UNMOUNTS, deliberately. A breach reported
 * while a window is tearing down belongs to that window's timeline, and a clock
 * restored on unmount would stamp it against a frame the window no longer has.
 */
const consoleTripwireRouteClock = new ForwardingConsoleClock(new RealClock());

// AT MODULE SCOPE FOR THE BOARDS' OWN REASON, ordering included. A tripwire can fire
// during the first render — an apply-chokepoint bypass, a surface that threw — and a
// route armed in an effect is armed after the paint that would have reported it, so
// the one class of breach the capture most needs to carry is the one it would miss.
//
// THE DETACH IS DELIBERATELY DROPPED. The route's lifetime is the renderer process's:
// there is no moment at which this window stops wanting its own invariant breaches
// recorded, and a handle held here would be a handle nothing could correctly call.
// A window that needs its own pair — a test, an auxiliary window with its own capture
// — arms `routeTripwiresToDiagnosticCapture` over registries of its own and touches
// neither of the singletons this line joins.
routeConsoleTripwiresToDiagnosticCapture(consoleTripwireRouteClock);

registerConsoleFamilies(
  consoleSurfaceRegistry,
  consolePaneRegistry,
  consoleEntityProjectorRegistry,
  inlineCardSeatRegistry,
);

export interface ConsoleRootProps {
  /** Which fixture scenario to play. Ignored when fixtures are compiled out. */
  readonly scenarioId?: string;
}

/** The console's mount point. `App.tsx` renders exactly this. */
export function ConsoleRoot(props: ConsoleRootProps): React.JSX.Element {
  return (
    <DesktopBridgeProvider
      {...(props.scenarioId === undefined ? {} : { scenarioId: props.scenarioId })}
      clockToRebind={consoleTripwireRouteClock}
    >
      <ConsoleFrameHost />
    </DesktopBridgeProvider>
  );
}
