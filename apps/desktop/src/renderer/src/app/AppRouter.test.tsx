// The router keys the mounted screen on what it is about. Two addresses can resolve to one screen
// for two subjects (a second session), and without the key React would carry what one session's
// screen holds into the next session's; two addresses inside one destination (the runs list and a
// run's page) are one subject, and a key on the whole address would throw away what the screen
// holds on every move. The pane harness is the probe screen for the first, because its open-pane
// count and each body's mount lifecycle show whether the screen was rebuilt; the workflows screen
// over the playback is the probe for the second, through what it holds for the sitting.

import { useEffect } from "react";

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { WORKFLOW_RUN_IDS } from "#fixtures/data/workflow/run/records.js";
import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { advanceScenarioUntil } from "#test/helpers/scenario-manual-clock.js";
import {
  createWorkflowCommandTargets,
  registerWorkflowScreens,
} from "#renderer/features/workflows/index.js";
import {
  attentionOf,
  mountWorkflowsScreen,
  navigate,
  nextWaitingControl,
  openRunId,
  press,
} from "#renderer/features/workflows/WorkflowsScreen.test-support.js";
import { workflowRunsRoute } from "#renderer/routing/readers.js";
import { type AppRoute } from "#renderer/routing/routes.js";
import { PaneRegistry } from "#renderer/registries/panes/registry.js";
import { type PaneContext } from "#renderer/registries/panes/context.js";
import { type PaneKind } from "#renderer/routing/panes/kinds.js";
import { WindowStore } from "#renderer/store/window/store.js";
import { registerPaneHarnessScreen } from "./pane-harness/register-screen.js";
import { AppRouter } from "./AppRouter.js";
import { screenRegistry } from "#renderer/registries/screens/registry.js";
import { type ScreenContext } from "#renderer/registries/screens/context.js";

afterEach(cleanup);

/** The session every harness route below is addressed at. */
const HARNESS_SESSION_ID = "session-under-harness";

/** A test-attribute name, so a case can read what a mounted body was handed. */
const MOUNTED_PANE_ID_ATTRIBUTE = "data-harness-pane-id";

function harnessRoute(paneKind: string, sessionId: string = HARNESS_SESSION_ID): AppRoute {
  return { kind: "pane-harness", paneKind, sessionId };
}

/** What the harness names one instance, spelled the way the screen spells it. */
function paneInstanceId(instanceIndex: number, sessionId: string = HARNESS_SESSION_ID): string {
  return `pane-harness-terminal-${sessionId}-${String(instanceIndex)}`;
}

/**
 * Which pane bodies mounted and unmounted, in order, by the id they were handed.
 *
 * A reconciled body keeps its id, so only the lifecycle tells a fresh instance from the same
 * instance reconciled against a new session.
 */
const mountedPaneLifecycle: string[] = [];

/** A real board whose one body is a stub reporting when it came and went. */
function boardWithStubBody(kind: PaneKind): PaneRegistry {
  const registry = new PaneRegistry();
  registry.register({
    kind,
    owner: "pane-harness-test",
    render: (context: PaneContext) => <StubPaneBody paneContext={context} />,
  });
  return registry;
}

function StubPaneBody(props: { readonly paneContext: PaneContext }): React.JSX.Element {
  const { paneId } = props.paneContext;
  useEffect(() => {
    mountedPaneLifecycle.push(`mounted ${paneId}`);
    return () => {
      mountedPaneLifecycle.push(`unmounted ${paneId}`);
    };
  }, [paneId]);
  return <div {...{ [MOUNTED_PANE_ID_ATTRIBUTE]: paneId }} />;
}

/**
 * The screen context a window would hand this screen.
 *
 * The frame store is real because the harness reads the route through it; the persistence stores
 * are cast away because constructing them opens a database for a screen that only passes them on.
 */
function screenContextFor(route: AppRoute): ScreenContext {
  return {
    route,
    bridge: {},
    frameStore: new WindowStore({ initialRoute: route }),
    // Present, since the router renders a session address with no store as still opening.
    sessionStore: {},
    sessionStoreRegistry: {},
    uiStateStore: {},
    draftStore: {},
  } as unknown as ScreenContext;
}

function mountedPaneIds(): readonly string[] {
  return [...document.querySelectorAll(`[${MOUNTED_PANE_ID_ATTRIBUTE}]`)].map(
    (element) => element.getAttribute(MOUNTED_PANE_ID_ATTRIBUTE) ?? "",
  );
}

/**
 * Press a control the way a person does, and let React finish reacting.
 *
 * `act` rather than a bare `click()`, whose commit would settle after the call and leave the
 * tree one render behind.
 */
async function pressControl(controlName: string): Promise<void> {
  await act(async () => {
    screen.getByRole("button", { name: controlName }).click();
    await crossMacrotaskBoundary();
  });
}

describe("AppRouter — the screen across an address change", () => {
  // Cleared before a case, since the file's `cleanup` unmounts the previous tree and would log
  // into the next case.
  beforeEach(() => {
    mountedPaneLifecycle.length = 0;
  });

  afterEach(() => {
    screenRegistry.unregister("pane-harness");
  });

  /** Claim the screen through the fixture registration, from a board built here. */
  function registerHarnessScreen(paneRegistry: PaneRegistry): void {
    registerPaneHarnessScreen(screenRegistry, paneRegistry);
  }

  function screenAt(route: AppRoute): React.JSX.Element {
    return <AppRouter context={screenContextFor(route)} />;
  }

  it("mounts no pane, and reuses no instance, when the session changes", async () => {
    registerHarnessScreen(boardWithStubBody("terminal"));
    const view = render(screenAt(harnessRoute("terminal", "session-one")));
    await pressControl("Open a pane");
    expect(mountedPaneIds()).toStrictEqual([paneInstanceId(0, "session-one")]);

    view.rerender(screenAt(harnessRoute("terminal", "session-two")));

    expect(mountedPaneIds()).toStrictEqual([]);
    expect(screen.getByText("terminal panes open: 0")).toBeTruthy();
    // The instance did not survive the move; a reconciled body would show no unmount.
    expect(mountedPaneLifecycle).toStrictEqual([
      `mounted ${paneInstanceId(0, "session-one")}`,
      `unmounted ${paneInstanceId(0, "session-one")}`,
    ]);
  });

  it("keeps its panes when the address has not changed", async () => {
    // A rerender at the same address is the same subject, so the count and instance stand;
    // otherwise the case above would pass for a router that rebuilt the screen every pass.
    registerHarnessScreen(boardWithStubBody("terminal"));
    const view = render(screenAt(harnessRoute("terminal")));
    await pressControl("Open a pane");

    view.rerender(screenAt(harnessRoute("terminal")));

    expect(mountedPaneIds()).toStrictEqual([paneInstanceId(0)]);
    expect(mountedPaneLifecycle).toStrictEqual([`mounted ${paneInstanceId(0)}`]);
  });
});

describe("AppRouter — the workflows screen across a run's page", () => {
  beforeAll(async () => {
    registerWorkflowScreens(screenRegistry, createWorkflowCommandTargets());
    await screenRegistry.preload("workflows");
  });

  afterAll(() => {
    screenRegistry.unregister("workflows");
  });

  it("opens the list with `That run is not here.` for a run the daemon does not have", async () => {
    const mounted = await mountWorkflowsScreen({
      route: workflowRunsRoute(UNKNOWN_RUN_ID),
      mount: routedThroughRouter,
    });

    await advanceScenarioUntil(mounted.engine, () => {
      expect(screen.getByText("That run is not here.")).toBeTruthy();
    });
    expect(openRunId(mounted)).toBeUndefined();
  });

  it("keeps the count of runs answered while a run's page opens and closes", async () => {
    const mounted = await mountWorkflowsScreen({
      route: workflowRunsRoute(undefined),
      mount: routedThroughRouter,
      answer: async (call, passThrough) => {
        const reply = await passThrough();
        return call.method === "workflow.runAttentionList"
          ? attentionOf(reply, [WORKFLOW_RUN_IDS.waitingApproval])
          : reply;
      },
    });
    await advanceScenarioUntil(mounted.engine, () => {
      expect(nextWaitingControl().textContent).toBe("Next waiting (1)");
    });

    await press("Next waiting (1)");
    await advanceScenarioUntil(mounted.engine, () => {
      expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    });
    await press("Approve");
    await advanceScenarioUntil(mounted.engine, () => {
      expect(screen.getByText(/^Approved at /u)).toBeTruthy();
    });
    await navigate(mounted);

    await advanceScenarioUntil(mounted.engine, () => {
      expect(screen.getByText(/^Nothing waiting · you answered 1 run this /u)).toBeTruthy();
    });
  });
});

/** A run id no run in the playback has. */
const UNKNOWN_RUN_ID = "019b7a10-0280-75e5-8510-ada11a5a4999";

/** The workflows screen as the window draws it: through the router. */
function routedThroughRouter(context: ScreenContext): React.JSX.Element {
  return <AppRouter context={context} />;
}
