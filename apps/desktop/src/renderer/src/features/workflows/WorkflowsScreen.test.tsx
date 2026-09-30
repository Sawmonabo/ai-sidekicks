// The screen draws the runs it is handed; pressing a run opens the pane that run names.
// The pane registry is real, built per case with the feature's own bodies, because the screen
// resolves from the registry on its screen context and a singleton would prove only that it
// reads a global.

import { render } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { LiveAnnouncerProvider } from "@renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { paneRegistry } from "@renderer/registries/panes/pane-registry.js";
import { type PaneContext } from "@renderer/registries/panes/pane-context.js";
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
 * Mount the screen over a composition whose run body records the pane context it is opened
 * with, which carries the address the screen composed.
 */
function renderDestination(directoryProps: { readonly directory?: WorkflowRunDirectoryState }): {
  readonly container: HTMLElement;
  /** Every pane context this screen opened, in the order it opened them. */
  readonly openedContexts: readonly PaneContext[];
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

function renderComposed(composed: ComposedWindow): HTMLElement {
  return mountWorkflowsScreen(composed).container;
}

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
    // Guards against a screen that opened a pane on mount.
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
    expect(container.querySelector(".meridian-workflows-open-pane")).toBeNull();
  });

  it("swaps the runs for the run pane when a run opens, and goes back", async () => {
    // Resolved through the pane layout's own lookup, so the screen renders what the layout would.
    const container = renderScreen();
    await settle();

    pressOpenRun(container);
    await settle();
    expect(container.querySelector(".meridian-workflows-open-pane")).not.toBeNull();
    expect(container.querySelector(".meridian-run-row__open")).toBeNull();

    pressFirst(container, ".meridian-workflows-open-pane__back");
    await settle();

    expect(container.querySelector(".meridian-run-row__open")).not.toBeNull();
    expect(container.querySelector(".meridian-workflows-open-pane")).toBeNull();
  });

  it("draws only its back control where the pane kind has no registered body", async () => {
    // With the body unregistered only the screen's own frame stands, so the mount above resolved a
    // real descriptor.
    const composed = composeWindow();
    composed.paneRegistry.unregister("workflow-run");
    const container = renderComposed(composed);
    await settle();

    pressOpenRun(container);
    await settle();

    expect(container.querySelector(".meridian-workflows-open-pane")?.children).toHaveLength(1);
  });
});

describe("which pane board the screen opens out of", () => {
  // A screen reading the process-wide singleton would give a separately composed window
  // the wrong body.

  /** A body only the process-wide board carries, so a case can tell the two apart. */
  const PROCESS_WIDE_RUN_TEXT = "the process-wide run body";

  // The singleton is process state; the one case that touches it restores it in its own `finally`,
  // since a suite-wide hook would make every case share a registry it never asked for.
  function registerProcessWideRunBody(): void {
    paneRegistry.register({
      kind: "workflow-run",
      owner: "workflows-screen-test-process-wide",
      render: () => <p>{PROCESS_WIDE_RUN_TEXT}</p>,
    });
  }

  it("mounts the composition's own body and consults the process-wide board for nothing", async () => {
    const composed = composeWindow();
    const mountedContexts = probeRunPane(composed.paneRegistry);
    const processWideReads = vi.spyOn(paneRegistry, "descriptorFor");
    try {
      const container = renderComposed(composed);
      await settle();
      pressOpenRun(container);
      await settle();

      expect(mountedContexts).toHaveLength(1);
      expect(container.textContent).toContain("probe");
      // Not consulted at all: a screen that read both would still be reading a global.
      expect(processWideReads).not.toHaveBeenCalled();
    } finally {
      processWideReads.mockRestore();
    }
  });

  it("negative control: the process-wide body does not stand in for one this board lacks", async () => {
    // Here the singleton has a body and this composition lacks one, as an auxiliary window
    // composing a subset would.
    const composed = composeWindow();
    composed.paneRegistry.unregister("workflow-run");
    registerProcessWideRunBody();
    try {
      // The boards disagree, so the assertion below says which one was read.
      expect(paneRegistry.descriptorFor("workflow-run")).toBeDefined();
      expect(composed.paneRegistry.descriptorFor("workflow-run")).toBeUndefined();

      const container = renderComposed(composed);
      await settle();
      pressOpenRun(container);
      await settle();

      expect(container.textContent).not.toContain(PROCESS_WIDE_RUN_TEXT);
      expect(container.querySelector(".meridian-workflows-open-pane")?.children).toHaveLength(1);
    } finally {
      paneRegistry.unregister("workflow-run");
    }
  });
});

describe("the pane about to open is warmed before the address is published", () => {
  it("starts the body loading while the runs are still on screen", async () => {
    // The warm must start before the address is published, because publishing mounts the pane
    // and a loader-backed body reached then shows its fallback first.
    const composed = composeWindow();
    const warmedWhileRunsShowing: string[] = [];
    const container = renderComposed(composed);
    await settle();

    const preload = vi.spyOn(composed.paneRegistry, "preload").mockImplementation(async (kind) => {
      if (container.querySelector(".meridian-workflows-open-pane") === null) {
        warmedWhileRunsShowing.push(kind);
      }
      return await Promise.resolve();
    });
    pressOpenRun(container);
    await settle();

    expect(warmedWhileRunsShowing).toStrictEqual(["workflow-run"]);
    expect(container.querySelector(".meridian-workflows-open-pane")).not.toBeNull();
    preload.mockRestore();
  });

  it("negative control: nothing is warmed while the runs are merely showing", async () => {
    // Guards against a screen that warmed every kind at mount, fetching bodies it may never need.
    const composed = composeWindow();
    const preload = vi.spyOn(composed.paneRegistry, "preload");
    renderComposed(composed);
    await settle();

    expect(preload).not.toHaveBeenCalled();
    preload.mockRestore();
  });
});
