// Where the console starts.
//
// The window's entry point: it composes the surface families and hands what it
// built to the bridge provider. Everything else is a sibling — `ConsoleFrameHost.tsx`
// is the bridge gate and the token sheet above it, `ConsoleFrame.tsx` is the window
// itself, `RouteSurface.tsx` resolves a route to a surface, and the five modules
// beside those own the command surface, the rail, the session registry, the durable
// store's life, and the colour scheme.
//
// What stays here is the one thing that has to happen before any window renders,
// and the provider that has to wrap every one of them.

import { type ReactNode } from "react";

import { SidekicksBridgeProvider } from "../bridge/index.js";
import { registerConsoleFamilies } from "../families.js";
import { consoleEntityProjectorRegistry } from "../store/index.js";
import {
  consolePaneRegistry,
  consoleSurfaceRegistry,
  frameBindingRegistry,
  inlineCardSeatRegistry,
  sidebarSectionRegistry,
  type ConsoleSurfaceContext,
} from "../seats/index.js";
import { ConsoleFrameHost } from "./ConsoleFrameHost.js";

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
// All six process-wide boards are named HERE rather than reached for inside the
// composition, which is what makes this the composition site: a test or an auxiliary
// window calls the same function with boards of its own and touches none of these.
//
// The sidebar and inline-card boards are named even though no family fills either
// yet, and that is the reason to name them: both ship a module-scope registrar that
// writes into the singleton, so a family reaching for one would compose into
// production from inside a composition that was handed something else. Passing them
// here is what makes that reach unnecessary.
//
// The projector board is the third, and its ORDER against the window below is the
// reason it is composed at module scope with the other two: a family claims the
// event kinds it folds here, and a window opens its first session store during
// render, which is strictly after. A store therefore opens with the fold the
// composition claimed rather than with whatever had registered by the time the
// first event arrived.
// The frame-binding board is the sixth, and the one whose claims are mounted by the
// frame rather than by a route. It is composed here with the rest for the projector
// board's reason: a binding is registered before any window renders, so the frame
// wraps its first subtree in every binding a family claimed rather than in whichever
// ones had evaluated by then.
registerConsoleFamilies(
  consoleSurfaceRegistry,
  consolePaneRegistry,
  consoleEntityProjectorRegistry,
  sidebarSectionRegistry,
  inlineCardSeatRegistry,
  frameBindingRegistry,
);

export interface ConsoleRootProps {
  /** Which fixture scenario to play. Ignored when fixtures are compiled out. */
  readonly scenarioId?: string;
  /** Window-scoped overlays — the command palette, dialogs. */
  readonly renderOverlays?: (context: ConsoleSurfaceContext) => ReactNode;
}

/** The console's mount point. `App.tsx` renders exactly this. */
export function ConsoleRoot(props: ConsoleRootProps): React.JSX.Element {
  return (
    <SidekicksBridgeProvider
      {...(props.scenarioId === undefined ? {} : { scenarioId: props.scenarioId })}
    >
      <ConsoleFrameHost
        {...(props.renderOverlays === undefined ? {} : { renderOverlays: props.renderOverlays })}
      />
    </SidekicksBridgeProvider>
  );
}
