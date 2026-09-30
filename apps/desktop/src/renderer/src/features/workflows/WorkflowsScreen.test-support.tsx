// One window's composition of the workflows screen, shared by the suites that drive it.
// Everything is real except the persistence stores, which are cast away because constructing
// them opens a database; the session store is `undefined` because `#/workflows` names no
// session. Bodies register through `registerWorkflowPanes`, as the pane layout would.
import { fireEvent, render } from "@testing-library/react";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { CONCURRENT_STREAMING_SCENARIO } from "../../../../../fixtures/scenarios/concurrent-streaming.js";
import { LiveAnnouncerProvider } from "@renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import type { AppRoute } from "@renderer/routing/routes.js";
import { WindowStore } from "@renderer/store/window/window-store.js";
import { PaneRegistry } from "@renderer/registries/panes/pane-registry.js";
import { type PaneContext } from "@renderer/registries/panes/pane-context.js";
import { type ScreenContext } from "@renderer/registries/screens/screen-context.js";
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
 * One window's composition: the screen context and its pane board. Built per case, because a
 * pane registry is owner-scoped state and a shared one would make cases depend on order.
 */
export interface ComposedWindow {
  readonly context: ScreenContext;
  readonly paneRegistry: PaneRegistry;
}

/** The `ScreenContext` the screen is handed, and this composition's own pane board. */
export function composeWindow(): ComposedWindow {
  const frameStore = new WindowStore();
  const committedRoute: AppRoute = { kind: "workflows" };
  frameStore.navigate(committedRoute);
  const paneRegistry = new PaneRegistry();
  registerWorkflowPanes(paneRegistry);
  return {
    paneRegistry,
    context: {
      route: committedRoute,
      bridge: createFixtureBridge({ scenario: CONCURRENT_STREAMING_SCENARIO }).bridge,
      frameStore,
      sessionStore: undefined,
      paneRegistry,
    } as unknown as ScreenContext,
  };
}

/** The same composition with a new bridge; the frame store, board and bodies carry over. */
export function withReplacedBridge(composed: ComposedWindow): ComposedWindow {
  return {
    paneRegistry: composed.paneRegistry,
    context: {
      ...composed.context,
      bridge: createFixtureBridge({ scenario: CONCURRENT_STREAMING_SCENARIO }).bridge,
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
 * Replace the run body on one composition's board with one that records the pane contexts it
 * is mounted with. The board is per composition, so no teardown is owed.
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
 * Load the run pane's lazy body ahead of the cases, so none ends and tears down its
 * environment mid-import.
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

/** The screen inside the announcer every screen renders in. */
function inWindowChrome(screen: React.ReactNode): React.JSX.Element {
  return <LiveAnnouncerProvider>{screen}</LiveAnnouncerProvider>;
}
