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

import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createFixtureBridge } from "../bridge/index.js";
import { WORKFLOWS_SCENARIO } from "../bridge/scenarios/workflows.js";
import { WORKFLOWS_SESSION_ID } from "../bridge/scenarios/workflow-fixture-ids.js";
import { ManualClock } from "../core/index.js";
import { LiveAnnouncerProvider } from "../primitives/index.js";
import { FrameStore, SessionStoreRegistry } from "../store/index.js";
import type { ConsolePaneContext } from "../seats/index.js";
import { ConsolePaneRegistry, consolePaneRegistry } from "../seats/index.js";
// Deep, for `index.ts`'s reason: the frame's barrel also exports `ConsoleRoot`, which
// composes the families, so a family reaching it through that door closes a cycle the
// layering gate rejects.
import type { ConsoleSurfaceContext } from "../frame/surface-registry.js";
import { registerWorkflowPanes } from "./index.js";
import { WorkflowsPaneHost } from "./WorkflowsPaneHost.js";

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
 * One window's composition: the context the slot is handed, and the board inside it.
 *
 * The board is handed back beside the context so a case can register a probe into the
 * very registry the render will resolve from. Built per case rather than shared,
 * because a pane registry is owner-scoped state and two cases holding one instance
 * would make the second depend on whether the first had run.
 */
interface ComposedWindow {
  readonly context: ConsoleSurfaceContext;
  readonly paneRegistry: ConsolePaneRegistry;
}

/**
 * The surface context the slot is handed, and this composition's own pane board.
 *
 * The bridge, the frame store, and both registries are real, because the host composes
 * a pane context out of them; the two persistence stores are cast away for
 * `RouteSurface.test.tsx`'s reason — constructing them opens a database to hand a
 * branch that never touches it.
 *
 * The bodies reach the board through `registerWorkflowPanes`, the family's own
 * registration call, rather than a hand-built table: the host's claim is that it mounts
 * what the DECK would mount, and a table assembled here would prove only that it mounts
 * what this file wrote.
 */
function composeWindow(options: SurfaceContextOptions = {}): ComposedWindow {
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

function renderComposed(composed: ComposedWindow): HTMLElement {
  const { container } = render(
    <LiveAnnouncerProvider>
      <WorkflowsPaneHost context={composed.context} />
    </LiveAnnouncerProvider>,
  );
  return container;
}

function renderHost(options: SurfaceContextOptions = DEFAULT_WINDOW): HTMLElement {
  return renderComposed(composeWindow(options));
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
function probeBuilderPane(paneRegistry: ConsolePaneRegistry): readonly ConsolePaneContext[] {
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
