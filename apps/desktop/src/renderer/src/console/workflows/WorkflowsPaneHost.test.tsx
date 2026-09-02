// The slot's whole claim: a name pressed in a list becomes the pane that name names.
//
// The host is driven end to end — the real fixture port, the real frame store, the
// real pane registry with this family's own bodies registered into it — because the
// defect it fixes was a chain that was complete everywhere except at the join: both
// pane kinds registered, both lists rendering, and no production act between them.
// A stand-in registry would have agreed with a host that resolved nothing.

import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createFixtureBridge } from "../bridge/index.js";
import { WORKFLOWS_SCENARIO } from "../bridge/scenarios/workflows.js";
import { WORKFLOWS_SESSION_ID } from "../bridge/scenarios/workflow-fixture-data.js";
import { ManualClock } from "../core/index.js";
import { LiveAnnouncerProvider } from "../primitives/index.js";
import { FrameStore, SessionStoreRegistry } from "../store/index.js";
import type { ConsolePaneContext } from "../workspace/index.js";
import { consolePaneRegistry } from "../workspace/index.js";
// Deep, for `index.ts`'s reason: the frame's barrel also exports `ConsoleRoot`, which
// composes the families, so a family reaching it through that door closes a cycle the
// layering gate rejects.
import type { ConsoleSurfaceContext } from "../frame/surface-registry.js";
import { registerWorkflowPanes } from "./index.js";
import { WorkflowsPaneHost } from "./WorkflowsPaneHost.js";

/**
 * This family's pane bodies, in the process-wide registry the host resolves through.
 *
 * The real registration call rather than a hand-built table: the host's claim is that
 * it mounts what the DECK would mount, and a table assembled here would prove only
 * that it mounts what this file wrote.
 */
registerWorkflowPanes(consolePaneRegistry);

afterEach(() => {
  consolePaneRegistry.unregister("workflow-builder");
  consolePaneRegistry.unregister("workflow-run");
  registerWorkflowPanes(consolePaneRegistry);
});

/** What a case varies about the window the slot is mounted in. */
interface SurfaceContextOptions {
  /** The session this window last opened, if it has opened one. */
  readonly retainedSessionId?: string;
  /** The sessions open in this window, whose stores the registry can hand out. */
  readonly openSessionIds?: readonly string[];
}

/** The window the cases about mounting assume: in the fixture's session, nothing open. */
const DEFAULT_WINDOW: SurfaceContextOptions = { retainedSessionId: WORKFLOWS_SESSION_ID };

/**
 * A session id this fixture serves nothing for, standing in for "somewhere else".
 *
 * A window retaining THIS is a window whose retention must not decide what an opened
 * pane reads, which is the whole of what the cases below separate.
 */
const FOREIGN_SESSION_ID = "019b7a10-0280-75e5-8510-ada11a5a9999";

/**
 * The surface context the slot is handed.
 *
 * The bridge, the frame store, and the registry are real, because the host composes a
 * pane context out of them; the two persistence stores are cast away for
 * `RouteSurface.test.tsx`'s reason — constructing them opens a database to hand a
 * branch that never touches it.
 */
function surfaceContext(options: SurfaceContextOptions = {}): ConsoleSurfaceContext {
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
  return {
    route: { kind: "workflows" },
    bridge: createFixtureBridge({ scenario: WORKFLOWS_SCENARIO }),
    frameStore,
    sessionStore: undefined,
    sessionStoreRegistry,
  } as unknown as ConsoleSurfaceContext;
}

function renderHost(options: SurfaceContextOptions = DEFAULT_WINDOW): HTMLElement {
  const { container } = render(
    <LiveAnnouncerProvider>
      <WorkflowsPaneHost context={surfaceContext(options)} />
    </LiveAnnouncerProvider>,
  );
  return container;
}

/**
 * Replace the builder body with one that records the context it was handed.
 *
 * A probe rather than an assertion against a real body, because no registered body
 * renders the session it was given: the store is handed on to slots whose own tests
 * check what they receive. The probe observes the seam this host owns — which store
 * it composed — and observes nothing else. The suite's `afterEach` puts the real
 * bodies back.
 */
function probeBuilderPane(): readonly ConsolePaneContext[] {
  const mountedContexts: ConsolePaneContext[] = [];
  consolePaneRegistry.unregister("workflow-builder");
  consolePaneRegistry.register({
    kind: "workflow-builder",
    owner: "workflows-pane-host-test",
    render: (context) => {
      mountedContexts.push(context);
      return <p>probe</p>;
    },
    openInWindow: false,
  });
  return mountedContexts;
}

/** Move the destination off its retained session and onto the one a person picks. */
async function chooseSessionInPicker(container: HTMLElement): Promise<void> {
  const rescope = container.querySelector(".meridian-workflows-destination__rescope");
  if (rescope instanceof HTMLElement) {
    fireEvent.click(rescope);
    await settle();
  }
  pressFirst(container, ".meridian-choice-list__choice");
  await settle();
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function pressFirst(container: HTMLElement, selector: string): void {
  const control = container.querySelector(selector);
  if (!(control instanceof HTMLElement)) {
    throw new Error(`nothing matched ${selector}`);
  }
  fireEvent.click(control);
}

describe("what the workflows slot mounts", () => {
  it("shows the destination's lists until something is opened", async () => {
    const container = renderHost();
    await settle();

    expect(container.querySelector(".meridian-workflow__scopes")).not.toBeNull();
    expect(container.querySelector(".meridian-workflows-runs")).not.toBeNull();
    expect(container.querySelector(".meridian-workflows-pane-host")).toBeNull();
  });

  it("mounts the builder in place of the lists when a definition is pressed", async () => {
    // The registered body, resolved through the deck's own door — so this surface
    // renders what the deck will render and cannot drift from it.
    const container = renderHost();
    await settle();

    pressFirst(container, ".meridian-definition-row__open");
    await settle();

    expect(container.querySelector(".meridian-workflows-pane-host")).not.toBeNull();
    expect(container.querySelector(".meridian-workflow__scopes")).toBeNull();
    expect(container.textContent).toContain("Workflow builder");
  });

  it("mounts the run pane when a run is pressed, and goes back", async () => {
    const container = renderHost();
    await settle();

    pressFirst(container, ".meridian-run-row__open");
    await settle();
    expect(container.querySelector(".meridian-workflows-pane-host")).not.toBeNull();

    pressFirst(container, ".meridian-workflows-pane-host__back");
    await settle();

    // Back to the lists, and the runs read is put again rather than the surface
    // showing whatever it held before the pane opened.
    expect(container.querySelector(".meridian-workflows-runs")).not.toBeNull();
    expect(container.querySelector(".meridian-workflows-pane-host")).toBeNull();
  });

  it("says a pane kind with no registered body is reserved rather than drawing a hole", async () => {
    // The negative control for both cases above: with the body unregistered the host
    // must say so, which is the only way to know the two mounts above resolved a real
    // descriptor rather than rendering whatever they were given.
    consolePaneRegistry.unregister("workflow-builder");
    const container = renderHost();
    await settle();

    pressFirst(container, ".meridian-definition-row__open");
    await settle();

    expect(container.textContent).toContain("reserved, not missing");
    expect(container.textContent).not.toContain("Workflow builder");
  });
});

describe("which session's store the opened pane is handed", () => {
  it("hands the pane the session a person chose, not the one the window retained", async () => {
    // The finding: the address carries a definition and never a session, so the host
    // resolved its own answer from the route and the retention — and a person who had
    // explicitly moved this surface to another session opened a builder reading the
    // one they left.
    const mountedContexts = probeBuilderPane();
    const container = renderHost({
      retainedSessionId: FOREIGN_SESSION_ID,
      openSessionIds: [WORKFLOWS_SESSION_ID],
    });
    await settle();

    await chooseSessionInPicker(container);
    pressFirst(container, ".meridian-definition-row__open");
    await settle();

    expect(mountedContexts.map((context) => context.sessionStore?.sessionId)).toStrictEqual([
      WORKFLOWS_SESSION_ID,
    ]);
  });

  it("hands the pane a chosen session's store where the window retained nothing", async () => {
    // The second half of the same defect: with nothing retained the old resolution
    // had nothing to peek at, so a pane opened after an explicit choice was handed no
    // store at all and every body under it rendered its own absence.
    const mountedContexts = probeBuilderPane();
    const container = renderHost({ openSessionIds: [WORKFLOWS_SESSION_ID] });
    await settle();

    await chooseSessionInPicker(container);
    pressFirst(container, ".meridian-definition-row__open");
    await settle();

    expect(mountedContexts.map((context) => context.sessionStore?.sessionId)).toStrictEqual([
      WORKFLOWS_SESSION_ID,
    ]);
  });

  it("negative control: with nothing chosen the retained session is still what a pane reads", async () => {
    // Without this the two cases above would pass over a host that had stopped
    // reading the window's retention at all — which is a different defect wearing the
    // same assertions, and would strand every person who never touches the picker.
    const mountedContexts = probeBuilderPane();
    const container = renderHost({
      retainedSessionId: WORKFLOWS_SESSION_ID,
      openSessionIds: [WORKFLOWS_SESSION_ID],
    });
    await settle();

    pressFirst(container, ".meridian-definition-row__open");
    await settle();

    expect(mountedContexts.map((context) => context.sessionStore?.sessionId)).toStrictEqual([
      WORKFLOWS_SESSION_ID,
    ]);
  });

  it("hands the pane no store where the chosen session is not open in this window", async () => {
    // Fail-closed rather than fall back: substituting whatever store this window does
    // hold would put a body on a session nobody named, which is the defect above with
    // the operands swapped. A pane with no store renders its own absence.
    const mountedContexts = probeBuilderPane();
    const container = renderHost({ retainedSessionId: WORKFLOWS_SESSION_ID });
    await settle();

    pressFirst(container, ".meridian-definition-row__open");
    await settle();

    expect(mountedContexts.map((context) => context.sessionStore)).toStrictEqual([undefined]);
  });
});
