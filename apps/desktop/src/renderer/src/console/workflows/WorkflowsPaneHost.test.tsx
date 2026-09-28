// The slot's whole claim: a run opened from the destination becomes the pane that run names.
//
// The host is driven with the real frame store and a real pane registry with this family's
// own bodies registered into it by the family's own registration call, so a stand-in
// registry cannot agree with a host that resolved nothing. The destination is substituted
// with one button that opens a run: the host hands it no runs to press.
//
// THE BOARD IS THE COMPOSITION'S AND IS BUILT PER CASE. `registerConsoleFamilies` takes a
// pane registry so a test and an auxiliary window can compose their own, and this host
// resolves from the one on its surface context. A suite that registered into the
// process-wide singleton instead would prove only that the host reads a global.

import { describe, expect, it, vi } from "vitest";

import { consolePaneRegistry } from "../seats/index.js";
import {
  composeWindow,
  mountWorkflowsSlot,
  pressFirst,
  pressOpenRun,
  probeRunPane,
  type ComposedWindow,
} from "./WorkflowsPaneHost.test-support.js";
import { settle } from "./workflows-probe.test-support.js";

vi.mock("./destination/index.js", async () => {
  const { stubDestinationModule } = await import("./workflows-probe.test-support.js");
  return stubDestinationModule();
});

/** Mount one already-composed window and hand back the tree it rendered into. */
function renderComposed(composed: ComposedWindow): HTMLElement {
  return mountWorkflowsSlot(composed).container;
}

/** Compose a window and mount the slot into it. */
function renderHost(): HTMLElement {
  return renderComposed(composeWindow());
}

describe("what the workflows slot mounts", () => {
  it("shows the destination until something is opened", async () => {
    const container = renderHost();
    await settle();

    expect(container.querySelector(".probe-open-run")).not.toBeNull();
    expect(container.querySelector(".meridian-workflows-pane-host")).toBeNull();
  });

  it("swaps the destination for the run pane when a run opens, and goes back", async () => {
    // The registered body, resolved through the deck's own door — so this surface
    // renders what the deck will render and cannot drift from it.
    const container = renderHost();
    await settle();

    pressOpenRun(container);
    await settle();
    expect(container.querySelector(".meridian-workflows-pane-host")).not.toBeNull();
    expect(container.querySelector(".probe-open-run")).toBeNull();

    pressFirst(container, ".meridian-workflows-pane-host__back");
    await settle();

    expect(container.querySelector(".probe-open-run")).not.toBeNull();
    expect(container.querySelector(".meridian-workflows-pane-host")).toBeNull();
  });

  it("draws only its back control where the pane kind has no registered body", async () => {
    // The negative control for the case above: with the body unregistered nothing but the
    // host's own frame stands, which is how to know the mount above resolved a real
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

describe("which pane board the surface opens out of", () => {
  // `registerConsoleFamilies` takes a pane registry so a test and an auxiliary window can
  // compose their own. A host that read the process-wide singleton instead would give such
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
      owner: "workflows-pane-host-test-process-wide",
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
  it("starts the body loading while the destination is still on screen", async () => {
    // The ordering IS the claim. Publishing the address re-renders this host and mounts
    // the pane, and a loader-backed body reached at that mount would show its reserved
    // frame first; one statement earlier, the fetch is already in flight. So the spy
    // asserts where the host was when it warmed — the destination still up, the pane host not
    // yet in the tree — rather than merely that a warm happened at all.
    const composed = composeWindow();
    const warmedWhileDestinationShowing: string[] = [];
    const container = renderComposed(composed);
    await settle();

    const preload = vi.spyOn(composed.paneRegistry, "preload").mockImplementation(async (kind) => {
      if (container.querySelector(".meridian-workflows-pane-host") === null) {
        warmedWhileDestinationShowing.push(kind);
      }
      return await Promise.resolve();
    });
    pressOpenRun(container);
    await settle();

    expect(warmedWhileDestinationShowing).toStrictEqual(["workflow-run"]);
    expect(container.querySelector(".meridian-workflows-pane-host")).not.toBeNull();
    preload.mockRestore();
  });

  it("negative control: nothing is warmed while the destination is merely showing", async () => {
    // Without this, both cases above would pass over a host that warmed every kind on
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
