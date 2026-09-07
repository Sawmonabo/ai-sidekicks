// The slot's whole claim: a name pressed in a list becomes the pane that name names.
//
// The host is driven end to end — the real fixture port, the real frame store, a real
// pane registry with this family's own bodies registered into it by the family's own
// registration call — because the defect it fixes was a chain that was complete
// everywhere except at the join: both pane kinds registered, both lists rendering, and
// no production act between them. A stand-in registry would have agreed with a host
// that resolved nothing.
//
// THE BOARD IS THE COMPOSITION'S AND IS BUILT PER CASE. `registerConsoleFamilies` takes
// a pane registry so a test and an auxiliary window can compose their own, and this
// host now resolves from the one on its surface context. A suite that registered into
// the process-wide singleton instead would prove the host reads a global rather than
// the composition it was handed — which is exactly the defect the last describe holds.

import { describe, expect, it, vi } from "vitest";

import { WORKFLOWS_SESSION_ID } from "../bridge/scenarios/workflow-fixture-ids.js";
import { consolePaneRegistry } from "../seats/index.js";
import {
  composeWindow,
  mountWorkflowsSlot,
  pressFirst,
  probeBuilderPane,
  chooseSessionInPicker,
  type ComposedWindow,
  type SurfaceContextOptions,
} from "./WorkflowsPaneHost.test-support.js";
import { settle } from "./workflows-probe.test-support.js";

/** The window the cases about mounting assume: in the fixture's session, nothing open. */
const DEFAULT_WINDOW: SurfaceContextOptions = { retainedSessionId: WORKFLOWS_SESSION_ID };

/**
 * A session id this fixture serves nothing for, standing in for "somewhere else".
 *
 * A window retaining THIS is a window whose retention must not decide what an opened
 * pane reads, which is the whole of what the cases below separate.
 */
const FOREIGN_SESSION_ID = "019b7a10-0280-75e5-8510-ada11a5a9999";

/** Mount one already-composed window and hand back the tree it rendered into. */
function renderComposed(composed: ComposedWindow): HTMLElement {
  return mountWorkflowsSlot(composed).container;
}

/** Compose a window from `options` and mount the slot into it. */
function renderHost(options: SurfaceContextOptions = DEFAULT_WINDOW): HTMLElement {
  return renderComposed(composeWindow(options));
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
    const composed = composeWindow(DEFAULT_WINDOW);
    composed.paneRegistry.unregister("workflow-builder");
    const container = renderComposed(composed);
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
    const composed = composeWindow({
      retainedSessionId: FOREIGN_SESSION_ID,
      openSessionIds: [WORKFLOWS_SESSION_ID],
    });
    const mountedContexts = probeBuilderPane(composed.paneRegistry);
    const container = renderComposed(composed);
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
    const composed = composeWindow({ openSessionIds: [WORKFLOWS_SESSION_ID] });
    const mountedContexts = probeBuilderPane(composed.paneRegistry);
    const container = renderComposed(composed);
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
    const composed = composeWindow({
      retainedSessionId: WORKFLOWS_SESSION_ID,
      openSessionIds: [WORKFLOWS_SESSION_ID],
    });
    const mountedContexts = probeBuilderPane(composed.paneRegistry);
    const container = renderComposed(composed);
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
    const composed = composeWindow({ retainedSessionId: WORKFLOWS_SESSION_ID });
    const mountedContexts = probeBuilderPane(composed.paneRegistry);
    const container = renderComposed(composed);
    await settle();

    pressFirst(container, ".meridian-definition-row__open");
    await settle();

    expect(mountedContexts.map((context) => context.sessionStore)).toStrictEqual([undefined]);
  });
});

describe("which pane board the surface opens out of", () => {
  // The defect these close: `registerConsoleFamilies` takes a pane registry so a test
  // and an auxiliary window can compose their own, and this host reached for the
  // process-wide singleton instead. Such a composition opened a definition and got the
  // reserved absence, or a production body it had deliberately not registered.

  /** A body only the process-wide board carries, so a case can tell the two apart. */
  const PROCESS_WIDE_BUILDER_TEXT = "the process-wide builder body";

  /**
   * Put that body on the process-wide board.
   *
   * The singleton is process state, so the one case that touches it restores it in its
   * own `finally` rather than through a suite-wide hook — which would leave every other
   * case sharing a registry it never asked for.
   */
  function registerProcessWideBuilderBody(): void {
    consolePaneRegistry.register({
      kind: "workflow-builder",
      owner: "workflows-pane-host-test-process-wide",
      render: () => <p>{PROCESS_WIDE_BUILDER_TEXT}</p>,
    });
  }

  it("mounts the composition's own body and consults the process-wide board for nothing", async () => {
    const composed = composeWindow(DEFAULT_WINDOW);
    const mountedContexts = probeBuilderPane(composed.paneRegistry);
    const processWideReads = vi.spyOn(consolePaneRegistry, "descriptorFor");
    try {
      const container = renderComposed(composed);
      await settle();
      pressFirst(container, ".meridian-definition-row__open");
      await settle();

      expect(mountedContexts).toHaveLength(1);
      expect(container.textContent).toContain("probe");
      // Not consulted at all, rather than consulted and overruled: a host that read
      // both would still be reading a global, and would still drift the day the two
      // boards carry different bodies for one kind.
      expect(processWideReads).not.toHaveBeenCalled();
    } finally {
      processWideReads.mockRestore();
    }
  });

  it("negative control: the process-wide body does not stand in for one this board lacks", async () => {
    // Without this, the case above would pass over a host that read the singleton and
    // happened to find nothing there. Here the singleton HAS a body and this
    // composition does not, which is the shape an auxiliary window composing a subset
    // is in — and the old host rendered the singleton's body into it.
    const composed = composeWindow(DEFAULT_WINDOW);
    composed.paneRegistry.unregister("workflow-builder");
    registerProcessWideBuilderBody();
    try {
      // The two boards disagree, which is what makes the assertion below say which one
      // was read rather than merely that something rendered.
      expect(consolePaneRegistry.descriptorFor("workflow-builder")).toBeDefined();
      expect(composed.paneRegistry.descriptorFor("workflow-builder")).toBeUndefined();

      const container = renderComposed(composed);
      await settle();
      pressFirst(container, ".meridian-definition-row__open");
      await settle();

      expect(container.textContent).toContain("reserved, not missing");
      expect(container.textContent).not.toContain(PROCESS_WIDE_BUILDER_TEXT);
    } finally {
      consolePaneRegistry.unregister("workflow-builder");
    }
  });
});

describe("the pane about to open is warmed before the address is published", () => {
  it("starts the body loading while the lists are still on screen", async () => {
    // The ordering IS the claim. Publishing the address re-renders this host and mounts
    // the pane, and a loader-backed body reached at that mount would show its reserved
    // frame first; one statement earlier, the fetch is already in flight. So the spy
    // asserts where the host was when it warmed — the lists still up, the pane host not
    // yet in the tree — rather than merely that a warm happened at all.
    const composed = composeWindow(DEFAULT_WINDOW);
    const warmedWhileListsShowing: string[] = [];
    const container = renderComposed(composed);
    await settle();

    const preload = vi.spyOn(composed.paneRegistry, "preload").mockImplementation(async (kind) => {
      if (container.querySelector(".meridian-workflows-pane-host") === null) {
        warmedWhileListsShowing.push(kind);
      }
      return await Promise.resolve();
    });
    pressFirst(container, ".meridian-run-row__open");
    await settle();

    expect(warmedWhileListsShowing).toStrictEqual(["workflow-run"]);
    expect(container.querySelector(".meridian-workflows-pane-host")).not.toBeNull();
    preload.mockRestore();
  });

  it("warms the kind the pressed row names, and only that one", async () => {
    // The board this family registers into holds two loader-backed kinds, so a host
    // that warmed the board rather than the address would be indistinguishable from a
    // correct one on the case above — and would fetch the builder's chunk every time
    // somebody opened a run.
    const composed = composeWindow(DEFAULT_WINDOW);
    const container = renderComposed(composed);
    await settle();

    const preload = vi.spyOn(composed.paneRegistry, "preload");
    pressFirst(container, ".meridian-definition-row__open");
    await settle();

    expect(preload.mock.calls.map(([kind]) => kind)).toStrictEqual(["workflow-builder"]);
    preload.mockRestore();
  });

  it("negative control: nothing is warmed while the destination is merely showing", async () => {
    // Without this, both cases above would pass over a host that warmed every kind on
    // its board at mount — every loader-backed body fetched for a surface a person may
    // never open a pane from, which is the static import back under another name.
    const composed = composeWindow(DEFAULT_WINDOW);
    const preload = vi.spyOn(composed.paneRegistry, "preload");
    renderComposed(composed);
    await settle();

    expect(preload).not.toHaveBeenCalled();
    preload.mockRestore();
  });
});
