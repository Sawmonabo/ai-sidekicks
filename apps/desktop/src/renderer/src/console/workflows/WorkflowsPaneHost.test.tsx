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
import { LiveAnnouncerProvider } from "../primitives/index.js";
import { FrameStore, SessionStoreRegistry } from "../store/index.js";
import { consolePaneRegistry, type ConsoleSurfaceContext } from "../workspace/index.js";
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

/**
 * The surface context the slot is handed.
 *
 * The bridge, the frame store, and the registry are real, because the host composes a
 * pane context out of them; the two persistence stores are cast away for
 * `RouteSurface.test.tsx`'s reason — constructing them opens a database to hand a
 * branch that never touches it.
 */
function surfaceContext(): ConsoleSurfaceContext {
  const frameStore = new FrameStore({
    initialRoute: { kind: "workspace", sessionId: WORKFLOWS_SESSION_ID },
  });
  frameStore.navigate({ kind: "workflows" });
  return {
    route: { kind: "workflows" },
    bridge: createFixtureBridge({ scenario: WORKFLOWS_SCENARIO }),
    frameStore,
    sessionStore: undefined,
    sessionStoreRegistry: new SessionStoreRegistry({ read: () => Promise.resolve(undefined) }),
  } as unknown as ConsoleSurfaceContext;
}

function renderHost(): HTMLElement {
  const { container } = render(
    <LiveAnnouncerProvider>
      <WorkflowsPaneHost context={surfaceContext()} />
    </LiveAnnouncerProvider>,
  );
  return container;
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
