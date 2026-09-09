// One window's composition of the workflows slot, for every suite that drives it.
//
// HOISTED ON THE SECOND USE, which is `apps/desktop/AGENTS.md`'s rule rather than a
// preference: the mount cases and the port-swap cases both need a real bridge, a real
// frame store, a real session-store registry and a real pane board with this family's
// own bodies registered into it, and a second copy of that composition would agree with
// the first until one of them grew a fifth input.
//
// EVERYTHING HERE IS REAL EXCEPT THE TWO PERSISTENCE STORES, which are cast away for
// `RouteSurface.test.tsx`'s reason — constructing them opens a database to hand a branch
// that never touches it. The bodies reach the board through `registerWorkflowPanes`, the
// family's own registration call, rather than a hand-built table: the host's claim is
// that it mounts what the DECK would mount, and a table assembled here would prove only
// that it mounts what this file wrote.

import { fireEvent, render } from "@testing-library/react";

import { SidekicksBridgeProvider } from "../bridge/BridgeProvider.js";
import { createFixtureBridge } from "../bridge/index.js";
import { WORKFLOWS_SCENARIO } from "../bridge/scenario/workflows/workflows.js";
import { ManualClock } from "../core/index.js";
import { LiveAnnouncerProvider } from "../primitives/index.js";
import type { ConsoleRoute } from "../routing/index.js";
import { FrameStore, SessionStoreRegistry } from "../store/index.js";
import type { ConsolePaneContext } from "../seats/index.js";
import { ConsolePaneRegistry } from "../seats/index.js";
// Deep, for `index.ts`'s reason: the frame's barrel also exports `ConsoleRoot`, which
// composes the families, so a family reaching it through that door closes a cycle the
// layering gate rejects.
import type { ConsoleSurfaceContext } from "../seats/index.js";
import { registerWorkflowPanes } from "./index.js";
import { settle } from "./workflows-probe.test-support.js";
import { WorkflowsPaneHost } from "./WorkflowsPaneHost.js";

/** What a case varies about the window the slot is mounted in. */
export interface SurfaceContextOptions {
  /** The session this window last opened, if it has opened one. */
  readonly retainedSessionId?: string;
  /** The sessions open in this window, whose stores the registry can hand out. */
  readonly openSessionIds?: readonly string[];
  /**
   * The route this window has committed. Defaults to the rail's own destination.
   *
   * Written into the frame store AND onto the context, because those are two readers of
   * one fact: the surface is handed the route, and the pane it opens reads the store.
   * A case that set one of them would be asserting against a window that does not exist.
   */
  readonly route?: ConsoleRoute;
}

/**
 * One window's composition: the context the slot is handed, and the board inside it.
 *
 * The board is handed back beside the context so a case can register a probe into the
 * very registry the render will resolve from. Built per case rather than shared,
 * because a pane registry is owner-scoped state and two cases holding one instance
 * would make the second depend on whether the first had run.
 */
export interface ComposedWindow {
  readonly context: ConsoleSurfaceContext;
  readonly paneRegistry: ConsolePaneRegistry;
}

/** The surface context the slot is handed, and this composition's own pane board. */
export function composeWindow(options: SurfaceContextOptions = {}): ComposedWindow {
  const frameStore = new FrameStore(
    options.retainedSessionId === undefined
      ? {}
      : { initialRoute: { kind: "workspace", sessionId: options.retainedSessionId } },
  );
  const committedRoute: ConsoleRoute = options.route ?? { kind: "workflows" };
  frameStore.navigate(committedRoute);
  // A manual clock so no refresh scheduler an opened session starts outlives the
  // case that opened it.
  const sessionStoreRegistry = new SessionStoreRegistry({
    read: () => Promise.resolve(undefined),
    clock: new ManualClock(),
  });
  for (const openSessionId of options.openSessionIds ?? []) {
    sessionStoreRegistry.open(openSessionId);
  }
  const paneRegistry = new ConsolePaneRegistry();
  registerWorkflowPanes(paneRegistry);
  return {
    paneRegistry,
    context: {
      route: committedRoute,
      bridge: createFixtureBridge({ scenario: WORKFLOWS_SCENARIO }),
      frameStore,
      sessionStore: undefined,
      sessionStoreRegistry,
      paneRegistry,
    } as unknown as ConsoleSurfaceContext,
  };
}

/**
 * The same composition with a REPLACED bridge, which is what a scenario switch is.
 *
 * Everything a window keeps across a switch is kept — the frame store, both
 * registries, the board and its bodies — because the defect a swap case is about is
 * what the HOST carried over, and a helper that rebuilt the window around the new port
 * would leave nothing for it to carry.
 */
export function withReplacedBridge(composed: ComposedWindow): ComposedWindow {
  return {
    paneRegistry: composed.paneRegistry,
    context: {
      ...composed.context,
      bridge: createFixtureBridge({ scenario: WORKFLOWS_SCENARIO }),
    } as unknown as ConsoleSurfaceContext,
  };
}

/**
 * One composition's surface, inside the chrome every console surface really renders in.
 *
 * THE BRIDGE PROVIDER IS NOT DECORATION. A console surface reaches the bridge through
 * it — that is what makes the fixture substitutable — and this family's subtree does:
 * the run pane's human-form shell reads the growth port from there rather than from a
 * member on the slot's mount, which is the OWNER's contract and may not be widened by
 * the console's stand-in body. It provides the composition's OWN bridge, so a swap case
 * that re-renders against a replaced one swaps what the subtree reads too.
 *
 * A function and not a component: it composes an element for a caller that is already
 * rendering, so a component here would put a second tree between the two providers and
 * remount the whole surface every time a case re-rendered.
 */
export function inWindowChrome(
  composed: ComposedWindow,
  surface: React.ReactNode,
): React.JSX.Element {
  return (
    <SidekicksBridgeProvider bridge={composed.context.bridge}>
      <LiveAnnouncerProvider>{surface}</LiveAnnouncerProvider>
    </SidekicksBridgeProvider>
  );
}

/** Mount the slot against one composition, handing back React's own render result. */
export function mountWorkflowsSlot(composed: ComposedWindow): ReturnType<typeof render> {
  return render(inWindowChrome(composed, <WorkflowsPaneHost context={composed.context} />));
}

/** Re-render the mounted slot against `composed`, which a swap case uses for the swap. */
export function remountWorkflowsSlot(
  rendered: ReturnType<typeof render>,
  composed: ComposedWindow,
): void {
  rendered.rerender(inWindowChrome(composed, <WorkflowsPaneHost context={composed.context} />));
}

/**
 * Replace the builder body on one composition's board with a recording one.
 *
 * A probe rather than an assertion against a real body, because no registered body
 * renders the session it was given: the store is handed on to slots whose own tests
 * check what they receive. The probe observes the seam this host owns — which store it
 * composed — and observes nothing else. It replaces the body on THAT composition's
 * board, so nothing outside the case sees it and no teardown is owed.
 */
export function probeBuilderPane(paneRegistry: ConsolePaneRegistry): readonly ConsolePaneContext[] {
  const mountedContexts: ConsolePaneContext[] = [];
  paneRegistry.unregister("workflow-builder");
  paneRegistry.register({
    kind: "workflow-builder",
    owner: "workflows-pane-host-test",
    render: (context) => {
      mountedContexts.push(context);
      return <p>probe</p>;
    },
  });
  return mountedContexts;
}

/** Move the destination off its retained session and onto the one a person picks. */
export async function chooseSessionInPicker(container: HTMLElement): Promise<void> {
  const rescope = container.querySelector(".meridian-workflows-destination__rescope");
  if (rescope instanceof HTMLElement) {
    fireEvent.click(rescope);
    await settle();
  }
  pressFirst(container, ".meridian-choice-list__choice");
  await settle();
}

/** Press the first element matching `selector`, refusing rather than silently passing. */
export function pressFirst(container: HTMLElement, selector: string): void {
  const control = container.querySelector(selector);
  if (!(control instanceof HTMLElement)) {
    throw new Error(`nothing matched ${selector}`);
  }
  fireEvent.click(control);
}
