// One window's composition of the workflows screen, with its own pane board.
// Everything is real except the persistence stores, which are cast away because constructing
// them opens a database; the session store is `undefined` because `#/workflows` names no
// session. Bodies register through `registerWorkflowPanes`, as the pane layout would.
import { fireEvent } from "@testing-library/react";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { CONCURRENT_STREAMING_SCENARIO } from "../../../../../fixtures/scenarios/concurrent-streaming.js";
import type { AppRoute } from "@renderer/routing/routes.js";
import { WindowStore } from "@renderer/store/window/window-store.js";
import { PaneRegistry } from "@renderer/registries/panes/pane-registry.js";
import { type PaneContext } from "@renderer/registries/panes/pane-context.js";
import { type ScreenContext } from "@renderer/registries/screens/screen-context.js";
import { registerWorkflowPanes } from "./contributions/panes.js";
import type { WorkflowRunDirectoryState } from "./runs/hooks/useWorkflowRunDirectory.js";
import { PROBE_RUNS } from "./workflows-probe.test-support.js";

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

/** Press the first run row's open control, which opens that run's pane. */
export function pressOpenRun(container: HTMLElement): void {
  pressFirst(container, ".meridian-run-row__open");
}

/** Press the first element matching `selector`, refusing rather than silently passing. */
function pressFirst(container: HTMLElement, selector: string): void {
  const control = container.querySelector(selector);
  if (!(control instanceof HTMLElement)) {
    throw new Error(`nothing matched ${selector}`);
  }
  fireEvent.click(control);
}
