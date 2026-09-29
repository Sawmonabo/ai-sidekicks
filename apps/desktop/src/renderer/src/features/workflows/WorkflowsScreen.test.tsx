// The screen draws the runs it is handed, and a run a person presses becomes the pane that
// run names.
//
// The screen is driven with the real frame store and a real pane registry with this
// feature's own bodies registered into it by its own registration call, so a stand-in
// registry cannot agree with a screen that resolved nothing.
//
// THE BOARD IS THE COMPOSITION'S AND IS BUILT PER CASE. `registerFeatureContributions` takes a
// pane registry so a test and an auxiliary window can compose their own, and this screen
// resolves from the one on its surface context. A suite that registered into the
// process-wide singleton instead would prove only that the screen reads a global.

import { render } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { LiveAnnouncerProvider } from "@renderer/console/primitives/index.js";
import { consolePaneRegistry, type ConsolePaneContext } from "@renderer/console/seats/index.js";
import type { WorkflowRunDirectoryState } from "./runs/hooks/useWorkflowRunDirectory.js";
import { PROBE_RUNS, settle } from "./workflows-probe.test-support.js";
import {
  SERVED_DIRECTORY,
  composeWindow,
  loadRunPaneBody,
  mountWorkflowsScreen,
  pressFirst,
  pressOpenRun,
  probeRunPane,
  type ComposedWindow,
} from "./WorkflowsScreen.test-support.js";
import { WorkflowsScreen } from "./WorkflowsScreen.js";

/**
 * Mount the screen over a composition whose run body records what it was opened on.
 *
 * The recording body stands where the run pane would: what this screen owes is the exact
 * address per act, and the pane context the body is handed carries that address.
 */
function renderDestination(directoryProps: { readonly directory?: WorkflowRunDirectoryState }): {
  readonly container: HTMLElement;
  /** Every pane context this screen opened, in the order it opened them. */
  readonly openedContexts: readonly ConsolePaneContext[];
} {
  const composed = composeWindow();
  const openedContexts = probeRunPane(composed.paneRegistry);
  const { container } = render(
    <LiveAnnouncerProvider>
      <WorkflowsScreen context={composed.context} {...directoryProps} />
    </LiveAnnouncerProvider>,
  );
  return { container, openedContexts };
}

/** Mount one already-composed window and hand back the tree it rendered into. */
function renderComposed(composed: ComposedWindow): HTMLElement {
  return mountWorkflowsScreen(composed).container;
}

/** Compose a window and mount the screen into it. */
function renderScreen(): HTMLElement {
  return renderComposed(composeWindow());
}

beforeAll(loadRunPaneBody);

describe("the workflows screen — the runs it draws", () => {
  it("lists the runs of the directory it is handed", async () => {
    const { container } = renderDestination({ directory: SERVED_DIRECTORY });
    await settle();

    expect(container.querySelector(".meridian-workflows-runs")).not.toBeNull();
    expect(container.querySelectorAll(".meridian-run-row")).toHaveLength(4);
  });

  it("draws its frame and no runs section when the mount supplies no directory", async () => {
    const { container } = renderDestination({});
    await settle();

    expect(container.querySelector(".meridian-workflows-destination")).not.toBeNull();
    expect(container.querySelector(".meridian-workflows-runs")).toBeNull();
    expect(container.querySelector(".meridian-run-list")).toBeNull();
  });
});

describe("the workflows screen — what its list opens", () => {
  it("opens the run pane on the run a person pressed", async () => {
    // The first row is the newest run, the one running now.
    const { container, openedContexts } = renderDestination({ directory: SERVED_DIRECTORY });
    await settle();
    const newestRun = PROBE_RUNS.find((candidate) => candidate.state === "running");
    if (newestRun === undefined) {
      throw new Error("no run is running");
    }

    pressOpenRun(container);
    await settle();

    expect(openedContexts).toHaveLength(1);
    expect(openedContexts[0]).toMatchObject({
      kind: "workflow-run",
      entity: { kind: "workflow-run", id: newestRun.workflowRunId },
    });
  });

  it("negative control: nothing is opened until something is pressed", async () => {
    // Without this the case above would pass over a surface that opened a pane on
    // mount, which is a different defect wearing the same assertions.
    const { openedContexts } = renderDestination({ directory: SERVED_DIRECTORY });
    await settle();

    expect(openedContexts).toStrictEqual([]);
  });
});

describe("what the workflows screen mounts", () => {
  it("shows the runs until something is opened", async () => {
    const container = renderScreen();
    await settle();

    expect(container.querySelector(".meridian-run-row__open")).not.toBeNull();
    expect(container.querySelector(".meridian-workflows-pane-host")).toBeNull();
  });

  it("swaps the runs for the run pane when a run opens, and goes back", async () => {
    // The registered body, resolved through the deck's own door — so this screen
    // renders what the deck will render and cannot drift from it.
    const container = renderScreen();
    await settle();

    pressOpenRun(container);
    await settle();
    expect(container.querySelector(".meridian-workflows-pane-host")).not.toBeNull();
    expect(container.querySelector(".meridian-run-row__open")).toBeNull();

    pressFirst(container, ".meridian-workflows-pane-host__back");
    await settle();

    expect(container.querySelector(".meridian-run-row__open")).not.toBeNull();
    expect(container.querySelector(".meridian-workflows-pane-host")).toBeNull();
  });

  it("draws only its back control where the pane kind has no registered body", async () => {
    // The negative control for the case above: with the body unregistered nothing but the
    // screen's own frame stands, which is how to know the mount above resolved a real
    // descriptor rather than rendering whatever it was given.
    const composed = composeWindow();
    composed.paneRegistry.unregister("workflow-run");
    const container = renderComposed(composed);
    await settle();

    pressOpenRun(container);
    await settle();

    expect(container.querySelector(".meridian-workflows-pane-host")?.children).toHaveLength(1);
  });
});

describe("which pane board the screen opens out of", () => {
  // `registerFeatureContributions` takes a pane registry so a test and an auxiliary window can
  // compose their own. A screen that read the process-wide singleton instead would give such
  // a composition the wrong body, or none.

  /** A body only the process-wide board carries, so a case can tell the two apart. */
  const PROCESS_WIDE_RUN_TEXT = "the process-wide run body";

  /**
   * Put that body on the process-wide board.
   *
   * The singleton is process state, so the one case that touches it restores it in its
   * own `finally` rather than through a suite-wide hook — which would leave every other
   * case sharing a registry it never asked for.
   */
  function registerProcessWideRunBody(): void {
    consolePaneRegistry.register({
      kind: "workflow-run",
      owner: "workflows-screen-test-process-wide",
      render: () => <p>{PROCESS_WIDE_RUN_TEXT}</p>,
    });
  }

  it("mounts the composition's own body and consults the process-wide board for nothing", async () => {
    const composed = composeWindow();
    const mountedContexts = probeRunPane(composed.paneRegistry);
    const processWideReads = vi.spyOn(consolePaneRegistry, "descriptorFor");
    try {
      const container = renderComposed(composed);
      await settle();
      pressOpenRun(container);
      await settle();

      expect(mountedContexts).toHaveLength(1);
      expect(container.textContent).toContain("probe");
      // Not consulted at all, rather than consulted and overruled: a screen that read
      // both would still be reading a global, and would still drift the day the two
      // boards carry different bodies for one kind.
      expect(processWideReads).not.toHaveBeenCalled();
    } finally {
      processWideReads.mockRestore();
    }
  });

  it("negative control: the process-wide body does not stand in for one this board lacks", async () => {
    // Without this, the case above would pass over a screen that read the singleton and
    // happened to find nothing there. Here the singleton HAS a body and this
    // composition does not, which is the shape an auxiliary window composing a subset
    // is in.
    const composed = composeWindow();
    composed.paneRegistry.unregister("workflow-run");
    registerProcessWideRunBody();
    try {
      // The two boards disagree, which is what makes the assertion below say which one
      // was read rather than merely that something rendered.
      expect(consolePaneRegistry.descriptorFor("workflow-run")).toBeDefined();
      expect(composed.paneRegistry.descriptorFor("workflow-run")).toBeUndefined();

      const container = renderComposed(composed);
      await settle();
      pressOpenRun(container);
      await settle();

      expect(container.textContent).not.toContain(PROCESS_WIDE_RUN_TEXT);
      expect(container.querySelector(".meridian-workflows-pane-host")?.children).toHaveLength(1);
    } finally {
      consolePaneRegistry.unregister("workflow-run");
    }
  });
});

describe("the pane about to open is warmed before the address is published", () => {
  it("starts the body loading while the runs are still on screen", async () => {
    // The ordering IS the claim. Publishing the address re-renders this screen and mounts
    // the pane, and a loader-backed body reached at that mount would show its reserved
    // frame first; one statement earlier, the fetch is already in flight. So the spy
    // asserts where the screen was when it warmed — the runs still up, the pane host not
    // yet in the tree — rather than merely that a warm happened at all.
    const composed = composeWindow();
    const warmedWhileRunsShowing: string[] = [];
    const container = renderComposed(composed);
    await settle();

    const preload = vi.spyOn(composed.paneRegistry, "preload").mockImplementation(async (kind) => {
      if (container.querySelector(".meridian-workflows-pane-host") === null) {
        warmedWhileRunsShowing.push(kind);
      }
      return await Promise.resolve();
    });
    pressOpenRun(container);
    await settle();

    expect(warmedWhileRunsShowing).toStrictEqual(["workflow-run"]);
    expect(container.querySelector(".meridian-workflows-pane-host")).not.toBeNull();
    preload.mockRestore();
  });

  it("negative control: nothing is warmed while the runs are merely showing", async () => {
    // Without this, both cases above would pass over a screen that warmed every kind on
    // its board at mount — every loader-backed body fetched for a surface a person may
    // never open a pane from, which is the static import back under another name.
    const composed = composeWindow();
    const preload = vi.spyOn(composed.paneRegistry, "preload");
    renderComposed(composed);
    await settle();

    expect(preload).not.toHaveBeenCalled();
    preload.mockRestore();
  });
});
