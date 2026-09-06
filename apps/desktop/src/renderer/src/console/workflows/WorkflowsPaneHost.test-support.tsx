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

import { createFixtureBridge } from "../bridge/index.js";
import { WORKFLOWS_SCENARIO } from "../bridge/scenarios/workflows.js";
import { ManualClock } from "../core/index.js";
import { LiveAnnouncerProvider } from "../primitives/index.js";
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
  frameStore.navigate({ kind: "workflows" });
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
      route: { kind: "workflows" },
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

/** Mount the slot against one composition, handing back React's own render result. */
export function mountWorkflowsSlot(composed: ComposedWindow): ReturnType<typeof render> {
  return render(
    <LiveAnnouncerProvider>
      <WorkflowsPaneHost context={composed.context} />
    </LiveAnnouncerProvider>,
  );
}

/** Re-render the mounted slot against `composed`, which a swap case uses for the swap. */
export function remountWorkflowsSlot(
  rendered: ReturnType<typeof render>,
  composed: ComposedWindow,
): void {
  rendered.rerender(
    <LiveAnnouncerProvider>
      <WorkflowsPaneHost context={composed.context} />
    </LiveAnnouncerProvider>,
  );
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
