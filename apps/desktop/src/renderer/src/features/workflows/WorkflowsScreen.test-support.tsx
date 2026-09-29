// One window's composition of the workflows screen, for every suite that drives it.
//
// Hoisted on the second use, per `apps/desktop/AGENTS.md`: the mount cases and the
// bridge-swap cases both need a real bridge, a real frame store and a real pane board with
// this feature's own bodies registered into it.
//
// Everything here is real except the persistence stores, which are cast away for
// `RouteSurface.test.tsx`'s reason: constructing them opens a database to hand a branch that
// never touches it. The session store is `undefined` because `#/workflows` names no session.
// The bodies reach the board through `registerWorkflowPanes`, the family's own registration
// call, rather than a hand-built table: the screen's claim is that it mounts what the deck
// would mount.
//
// THE SCREEN IS MOUNTED WITH A SERVED RUN DIRECTORY, so a suite opens a run by pressing a
// real row; `pressOpenRun` presses the first one.

import { fireEvent, render } from "@testing-library/react";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { CONCURRENT_STREAMING_SCENARIO } from "../../../../../fixtures/scenarios/concurrent-streaming.js";
import { LiveAnnouncerProvider } from "@renderer/console/primitives/index.js";
import type { ConsoleRoute } from "@renderer/routing/routes.js";
import { WindowStore } from "@renderer/store/window/window-store.js";
import {
  PaneRegistry,
  type PaneContext,
  type ScreenContext,
} from "@renderer/console/seats/index.js";
import { registerWorkflowPanes } from "./contributions/panes.js";
import type { WorkflowRunDirectoryState } from "./runs/hooks/useWorkflowRunDirectory.js";
import { PROBE_RUNS } from "./workflows-probe.test-support.js";
import { WorkflowsScreen } from "./WorkflowsScreen.js";

/** The probe runs as an enumeration serves them. */
export const SERVED_DIRECTORY: WorkflowRunDirectoryState = {
  status: "served",
  runs: PROBE_RUNS.map((run) => ({ ...run, definitionName: "Ship pipeline" })),
};

/**
 * One window's composition: the context the screen is handed, and the board inside it.
 *
 * The board is handed back beside the context so a case can register a probe into the
 * very registry the render will resolve from. Built per case rather than shared,
 * because a pane registry is owner-scoped state and two cases holding one instance
 * would make the second depend on whether the first had run.
 */
export interface ComposedWindow {
  readonly context: ScreenContext;
  readonly paneRegistry: PaneRegistry;
}

/** The surface context the screen is handed, and this composition's own pane board. */
export function composeWindow(): ComposedWindow {
  const frameStore = new WindowStore();
  const committedRoute: ConsoleRoute = { kind: "workflows" };
  frameStore.navigate(committedRoute);
  const paneRegistry = new PaneRegistry();
  registerWorkflowPanes(paneRegistry);
  return {
    paneRegistry,
    context: {
      route: committedRoute,
      bridge: createFixtureBridge({ scenario: CONCURRENT_STREAMING_SCENARIO }),
      frameStore,
      sessionStore: undefined,
      paneRegistry,
    } as unknown as ScreenContext,
  };
}

/**
 * The same composition with a replaced bridge.
 *
 * Everything a window keeps across a swap is kept: the frame store, the board and its
 * bodies. What a swap case is about is what the screen carried over.
 */
export function withReplacedBridge(composed: ComposedWindow): ComposedWindow {
  return {
    paneRegistry: composed.paneRegistry,
    context: {
      ...composed.context,
      bridge: createFixtureBridge({ scenario: CONCURRENT_STREAMING_SCENARIO }),
    } as unknown as ScreenContext,
  };
}

/** Mount the screen against one composition, handing back React's own render result. */
export function mountWorkflowsScreen(composed: ComposedWindow): ReturnType<typeof render> {
  return render(inWindowChrome(screenOver(composed)));
}

/** Re-render the mounted screen against `composed`, which a swap case uses for the swap. */
export function remountWorkflowsScreen(
  rendered: ReturnType<typeof render>,
  composed: ComposedWindow,
): void {
  rendered.rerender(inWindowChrome(screenOver(composed)));
}

/**
 * Replace the run body on one composition's board with a recording one.
 *
 * The probe observes the pane context this screen composed and nothing else. It replaces
 * the body on that composition's board, so nothing outside the case sees it and no
 * teardown is owed.
 */
export function probeRunPane(paneRegistry: PaneRegistry): readonly PaneContext[] {
  const mountedContexts: PaneContext[] = [];
  paneRegistry.unregister("workflow-run");
  paneRegistry.register({
    kind: "workflow-run",
    owner: "workflows-screen-test",
    render: (context) => {
      mountedContexts.push(context);
      return <p>probe</p>;
    },
  });
  return mountedContexts;
}

/** Press the first element matching `selector`, refusing rather than silently passing. */
export function pressFirst(container: HTMLElement, selector: string): void {
  const control = container.querySelector(selector);
  if (!(control instanceof HTMLElement)) {
    throw new Error(`nothing matched ${selector}`);
  }
  fireEvent.click(control);
}

/**
 * Loads the run pane's lazy body ahead of the cases. A case that opens the pane would
 * otherwise start that import and could end, and tear its environment down, before it
 * finished.
 */
export async function loadRunPaneBody(): Promise<void> {
  await import("./run-page/run-page-body.js");
}

/** Press the first run row's open control, which opens that run's pane. */
export function pressOpenRun(container: HTMLElement): void {
  pressFirst(container, ".meridian-run-row__open");
}

/** The screen over one composition, with the served run directory. */
function screenOver(composed: ComposedWindow): React.JSX.Element {
  return <WorkflowsScreen context={composed.context} directory={SERVED_DIRECTORY} />;
}

/**
 * One surface inside the announcer every console surface really renders in.
 *
 * A function and not a component: it composes an element for a caller that is already
 * rendering, so a component here would put a second tree in between and remount the
 * whole surface every time a case re-rendered.
 */
function inWindowChrome(surface: React.ReactNode): React.JSX.Element {
  return <LiveAnnouncerProvider>{surface}</LiveAnnouncerProvider>;
}
