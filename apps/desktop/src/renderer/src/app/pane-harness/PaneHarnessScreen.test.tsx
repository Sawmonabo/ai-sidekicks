// The fixture pane harness: what it mounts, out of which board, and what it says when it can
// mount nothing. The `terminal-instance-memory` budget reads a heap difference across it, so
// three properties are load-bearing for a number: it resolves the body from the pane board it
// was handed, opening a second instance leaves the first mounted (so the slope is a slope), and
// every instance gets the window's own bridge and stores. The body is a stub because the subject
// is the harness; the endurance tier mounts the real body in a real window.

import { useEffect } from "react";

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { type AppRoute } from "@renderer/routing/routes.js";
import { PaneRegistry } from "@renderer/registries/panes/pane-registry.js";
import { type PaneContext } from "@renderer/registries/panes/pane-context.js";
import { type PaneKind } from "@renderer/routing/panes/pane-kinds.js";
import { WindowStore } from "@renderer/store/window/window-store.js";
import { PaneHarnessScreen } from "./PaneHarnessScreen.js";
import { AppRouter } from "../router.js";
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

/**
 * A stub body for one kind, reporting what it was handed and when it came and went.
 *
 * The registry is real because the harness's resolve is the subject; only the body is a stub.
 */
function registerStubBody(registry: PaneRegistry, kind: PaneKind): void {
  registry.register({
    kind,
    owner: "pane-harness-test",
    render: (context: PaneContext) => <StubPaneBody paneContext={context} />,
  });
}

function StubPaneBody(props: { readonly paneContext: PaneContext }): React.JSX.Element {
  const { paneId, sessionStore } = props.paneContext;
  useEffect(() => {
    mountedPaneLifecycle.push(`mounted ${paneId}`);
    return () => {
      mountedPaneLifecycle.push(`unmounted ${paneId}`);
    };
  }, [paneId]);
  return (
    <div
      {...{ [MOUNTED_PANE_ID_ATTRIBUTE]: paneId }}
      data-harness-session={sessionStore === undefined ? "absent" : "present"}
    />
  );
}

function boardWithStubBody(kind: PaneKind): PaneRegistry {
  const registry = new PaneRegistry();
  registerStubBody(registry, kind);
  return registry;
}

/** A board carrying a body for both kinds the route-keying cases address. */
function boardWithBothStubBodies(): PaneRegistry {
  const registry = new PaneRegistry();
  registerStubBody(registry, "terminal");
  registerStubBody(registry, "browser");
  return registry;
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
    // Present, so a case can tell a pass-through from nothing passed.
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
async function pressControl(controlName: string, times = 1): Promise<void> {
  await act(async () => {
    for (let press = 0; press < times; press += 1) {
      screen.getByRole("button", { name: controlName }).click();
    }
    await crossMacrotaskBoundary();
  });
}

describe("the fixture pane harness", () => {
  it("mounts nothing until it is asked to, and one body per ask", async () => {
    render(
      <PaneHarnessScreen
        context={screenContextFor(harnessRoute("terminal"))}
        paneRegistry={boardWithStubBody("terminal")}
      />,
    );

    // The measurement's baseline: no instance is held. A harness that mounted one on arrival
    // would fold it into the baseline and report every later one as free.
    expect(mountedPaneIds()).toStrictEqual([]);
    expect(screen.getByText("terminal panes open: 0")).toBeTruthy();

    await pressControl("Open a pane");
    expect(mountedPaneIds()).toStrictEqual([paneInstanceId(0)]);
    expect(screen.getByText("terminal panes open: 1")).toBeTruthy();
  });

  it("leaves the earlier instances mounted when another is opened", async () => {
    render(
      <PaneHarnessScreen
        context={screenContextFor(harnessRoute("terminal"))}
        paneRegistry={boardWithStubBody("terminal")}
      />,
    );
    await pressControl("Open a pane", 3);

    // Three distinct instances in order. If opening the second replaced the first, every reading
    // would be the cost of one pane and the budget's slope check would compare a number to itself.
    expect(mountedPaneIds()).toStrictEqual([
      paneInstanceId(0),
      paneInstanceId(1),
      paneInstanceId(2),
    ]);

    await pressControl("Close the newest pane");
    expect(mountedPaneIds()).toStrictEqual([paneInstanceId(0), paneInstanceId(1)]);
  });

  it("hands each instance the window's own session store", async () => {
    render(
      <PaneHarnessScreen
        context={screenContextFor(harnessRoute("terminal"))}
        paneRegistry={boardWithStubBody("terminal")}
      />,
    );
    await pressControl("Open a pane");

    // A pane handed no store renders its not-bound absence and would sit inside any budget while
    // holding none of what the budget measures.
    expect(
      document
        .querySelector(`[${MOUNTED_PANE_ID_ATTRIBUTE}]`)
        ?.getAttribute("data-harness-session"),
    ).toBe("present");
  });

  it("refuses an address that names no pane kind, by the parser's own code", () => {
    render(
      <PaneHarnessScreen
        context={screenContextFor(harnessRoute("not-a-pane-kind"))}
        paneRegistry={boardWithStubBody("terminal")}
      />,
    );

    // The console's one admission point decides this, and its code reaches the screen verbatim.
    expect(screen.getByText(/pane-kind-unknown/u)).toBeTruthy();
    expect(mountedPaneIds()).toStrictEqual([]);
  });

  it("says a pane kind is reserved rather than stubbed when no feature registered it", async () => {
    render(
      <PaneHarnessScreen
        context={screenContextFor(harnessRoute("terminal"))}
        // A real board that claims a different kind, so `terminal` has no body.
        paneRegistry={boardWithStubBody("browser")}
      />,
    );

    expect(screen.getByText("No feature has registered a body for this pane kind.")).toBeTruthy();
    // The open control is inert, so a driver cannot count an absence as an instance.
    expect(screen.getByRole("button", { name: "Open a pane" }).hasAttribute("disabled")).toBe(true);
    await pressControl("Open a pane");
    expect(mountedPaneIds()).toStrictEqual([]);
  });

  it("negative control: it resolves out of the board it was handed, not a singleton", async () => {
    // Without this, the cases above would pass for a harness that reached for the production
    // `paneRegistry`, where `terminal` resolves while the parameter does nothing.
    render(
      <PaneHarnessScreen
        context={screenContextFor(harnessRoute("terminal"))}
        paneRegistry={new PaneRegistry()}
      />,
    );
    await pressControl("Open a pane");
    expect(mountedPaneIds()).toStrictEqual([]);
    expect(screen.getByText("No feature has registered a body for this pane kind.")).toBeTruthy();
  });

  it("says so when it is mounted on an address it does not serve", () => {
    render(
      <PaneHarnessScreen
        context={screenContextFor({ kind: "workflows" })}
        paneRegistry={boardWithStubBody("terminal")}
      />,
    );
    expect(
      screen.getByText("This screen was opened at an address it does not serve."),
    ).toBeTruthy();
  });
});

// The harness is keyed to the route it was addressed at. Two `#/pane-harness/…` addresses
// resolve to one screen, so without the key React would carry the open-pane count, and even the
// instances, across a hash change. These cases go through `AppRouter`, since the key is its
// decision.
describe("the harness across a route change", () => {
  const HARNESS_OWNER = "pane-harness-route-keying-test";

  // Cleared before a case, since the file's `cleanup` unmounts the previous tree and would log
  // into the next case.
  beforeEach(() => {
    mountedPaneLifecycle.length = 0;
  });

  afterEach(() => {
    screenRegistry.unregister("pane-harness");
  });

  /** Claim the screen the way the fixture registration does, from a board built here. */
  function registerHarnessScreen(paneRegistry: PaneRegistry): void {
    screenRegistry.register({
      name: "pane-harness",
      owner: HARNESS_OWNER,
      render: (context) => <PaneHarnessScreen context={context} paneRegistry={paneRegistry} />,
    });
  }

  function screenAt(route: AppRoute): React.JSX.Element {
    return <AppRouter context={screenContextFor(route)} />;
  }

  it("mounts no pane when the addressed pane kind changes", async () => {
    registerHarnessScreen(boardWithBothStubBodies());
    const view = render(screenAt(harnessRoute("terminal")));
    await pressControl("Open a pane", 2);
    expect(mountedPaneIds()).toHaveLength(2);

    view.rerender(screenAt(harnessRoute("browser")));

    // A fresh harness on the new address, not the old count.
    expect(mountedPaneIds()).toStrictEqual([]);
    expect(screen.getByText("browser panes open: 0")).toBeTruthy();
  });

  it("mounts no pane, and reuses no instance, when the session changes", async () => {
    registerHarnessScreen(boardWithBothStubBodies());
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
    // otherwise the cases above would pass for a harness that rebuilt itself every pass.
    registerHarnessScreen(boardWithBothStubBodies());
    const view = render(screenAt(harnessRoute("terminal")));
    await pressControl("Open a pane");

    view.rerender(screenAt(harnessRoute("terminal")));

    expect(mountedPaneIds()).toStrictEqual([paneInstanceId(0)]);
    expect(mountedPaneLifecycle).toStrictEqual([`mounted ${paneInstanceId(0)}`]);
  });

  it("negative control: the unkeyed mount carries the count across the change", async () => {
    // Rendering the component directly is the unkeyed position: React reconciles the harness
    // across the change, which is why the cases above have to go through the route.
    const paneRegistry = boardWithBothStubBodies();
    const view = render(
      <PaneHarnessScreen
        context={screenContextFor(harnessRoute("terminal"))}
        paneRegistry={paneRegistry}
      />,
    );
    await pressControl("Open a pane");

    view.rerender(
      <PaneHarnessScreen
        context={screenContextFor(harnessRoute("browser"))}
        paneRegistry={paneRegistry}
      />,
    );

    expect(screen.getByText("browser panes open: 1")).toBeTruthy();
  });
});
