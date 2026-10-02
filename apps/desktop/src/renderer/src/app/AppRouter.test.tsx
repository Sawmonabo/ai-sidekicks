// The router keys the mounted screen on its address. Two addresses can resolve to one screen (a
// second session), and without the key React would carry what one session's screen holds into
// the next session's. The pane harness is the probe screen, because its open-pane count and each
// body's mount lifecycle show whether the screen was rebuilt; the body is a stub.

import { useEffect } from "react";

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { type AppRoute } from "@renderer/routing/routes.js";
import { PaneRegistry } from "@renderer/registries/panes/pane-registry.js";
import { type PaneContext } from "@renderer/registries/panes/pane-context.js";
import { type PaneKind } from "@renderer/routing/panes/pane-kinds.js";
import { WindowStore } from "@renderer/store/window/window-store.js";
import { registerPaneHarnessScreen } from "./pane-harness/register-pane-harness-screen.js";
import { AppRouter } from "./AppRouter.js";
import { screenRegistry } from "@renderer/registries/screens/screen-registry.js";
import { type ScreenContext } from "@renderer/registries/screens/screen-context.js";

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
