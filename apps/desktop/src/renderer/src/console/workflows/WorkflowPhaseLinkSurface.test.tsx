// Following `#/session/<sid>/workflow/<rid>/phase/<pid>` all the way from the hash.
//
// The defect this closes is an address that reached nothing: the grammar has parsed the
// phase link since it shipped and the route's `workflowPhase` had no consumer anywhere
// outside `routing/`, so following such a link mounted the ordinary workspace and the run
// it named never appeared. These cases start at the HASH rather than at a hand-built
// route, so what is asserted is the whole path a person takes — parse, slot, the family's
// own registration, the mounted pane, and the run read that pane actually put.
//
// THE PANE IS REACHED THROUGH THE BOARD, NOT ASSERTED IN MARKUP. What proves the run
// pane opened at the right run is the run read it puts, spied on the real fixture port:
// a class name would pass over a pane mounted at some other run, and there is no run id
// in this family's chrome that a second reader could not have written.

import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { parseRoute, type ConsoleRoute } from "../routing/index.js";
import {
  ConsoleSurfaceRegistry,
  PinnedPaneRegionRegistry,
  surfaceSlotFor,
} from "../seats/index.js";
import { WORKFLOWS_PARKED_RUN } from "../bridge/scenarios/workflow-fixture-runs.js";
import { registerWorkflowSurfaces } from "./index.js";
import { fixtureHumanWait } from "./pane/run/WorkflowRunPane.test-support.js";
import { composeWindow, inWindowChrome } from "./WorkflowsPaneHost.test-support.js";
import { settle } from "./workflows-probe.test-support.js";

/**
 * The phase segment the link carries: the fixture's own wait, and not a made-up id.
 *
 * This surface consults none of it — any well-formed segment parses, and which form
 * opens is resolved inside the pane against the snapshot. Reading the real one anyway
 * is what keeps the address these cases follow one a park banner could have written,
 * and it is the same reader the pane's own suites use rather than a second copy.
 */
const ADDRESSED_PHASE_ID = fixtureHumanWait().phaseId;

/** What following one link produced: what was read, what stands there, and its words. */
interface FollowedLink {
  readonly runReadsFor: readonly string[];
  readonly hasRunPane: boolean;
  readonly text: string;
}

/** The hash a park banner, a run row, or a notification hands somebody. */
const PHASE_LINK = `#/session/${WORKFLOWS_PARKED_RUN.sessionId}/workflow/${WORKFLOWS_PARKED_RUN.workflowRunId}/phase/${ADDRESSED_PHASE_ID}`;

describe("the workflow phase link — from the hash to the run pane", () => {
  /** The workflows family's own surface board, registered the way the console does it. */
  function surfacesOfThisFamily(): ConsoleSurfaceRegistry {
    const registry = new ConsoleSurfaceRegistry();
    registerWorkflowSurfaces(registry, new PinnedPaneRegionRegistry());
    return registry;
  }

  /**
   * Mount whatever the phase route names, and hand back the run reads it put.
   *
   * BOTH BOARDS ARE PRELOADED, and that is two loaders rather than one: the surface is
   * reached by following a link and the run pane is opened from a list or an address, so
   * neither is on the flagship first paint and both arrive as their own chunk. A render
   * taken after only the first photographs the pane board's reserved frame — stable,
   * green, and a picture of a pane that had not loaded.
   */
  async function followRoute(route: ConsoleRoute): Promise<FollowedLink> {
    const slot = surfaceSlotFor(route);
    if (slot === undefined) {
      throw new Error("the route names no surface slot at all");
    }
    const registry = surfacesOfThisFamily();
    const descriptor = registry.descriptorFor(slot);
    if (descriptor === undefined) {
      throw new Error(`the workflows family registers no surface for "${slot}"`);
    }
    const composed = composeWindow({ route });
    const runRead = vi.spyOn(composed.context.bridge.growth, "workflowRunRead");
    await registry.preload(slot);
    await composed.paneRegistry.preload("workflow-run");
    let container: HTMLElement | undefined;
    await act(async () => {
      container = render(inWindowChrome(composed, descriptor.render(composed.context))).container;
    });
    await settle();
    return {
      runReadsFor: runRead.mock.calls.map(([request]) => request.workflowRunId),
      text: container?.textContent ?? "",
      hasRunPane: container?.querySelector(".meridian-pane--workflow-run") !== null,
    };
  }

  it("names this family's own slot rather than the bare workspace", () => {
    // The pre-fix reading of the same address: `surfaceSlotFor` resolved every
    // workspace route to `"workspace"`, a slot this family registers nothing for, so
    // the link mounted whichever body owned that seat and the run was never asked for.
    expect(surfaceSlotFor(parseRoute(PHASE_LINK))).toBe("workflow-phase");
    expect(surfacesOfThisFamily().registeredSlots()).toContain("workflow-phase");
  });

  it("opens the run the link names, and reads it", async () => {
    const followed = await followRoute(parseRoute(PHASE_LINK));
    expect(followed.runReadsFor).toStrictEqual([WORKFLOWS_PARKED_RUN.workflowRunId]);
    expect(followed.hasRunPane).toBe(true);
  });

  it("puts the pane's own absence in front of a run the session does not carry", async () => {
    // A link outlives the run it names. What the person gets is the run pane saying so
    // in the read's own words — never a blank workspace, and never a refusal this
    // surface composed, which would be a second answer to a question the port settles.
    const unknownRunId = "019b7a10-0280-7b33-8100-4011115a00ff";
    const followed = await followRoute(
      parseRoute(
        `#/session/${WORKFLOWS_PARKED_RUN.sessionId}/workflow/${unknownRunId}/phase/${ADDRESSED_PHASE_ID}`,
      ),
    );

    expect(followed.runReadsFor).toStrictEqual([unknownRunId]);
    expect(followed.hasRunPane).toBe(true);
    expect(followed.text).toContain("workflow.not_found");
  });

  it("negative control: the bare workspace address reaches nothing this family owns", async () => {
    // Without this, the two cases above would pass over a family that claimed the
    // workspace seat outright — which would put a run pane in front of every person who
    // opened a session, whether or not they had followed a link to one.
    const bareWorkspace = parseRoute(`#/session/${WORKFLOWS_PARKED_RUN.sessionId}`);
    expect(surfaceSlotFor(bareWorkspace)).toBe("workspace");
    expect(surfacesOfThisFamily().registeredSlots()).not.toContain("workspace");
  });

  it("negative control: handed a route with no phase, it reads no run", async () => {
    // The surface is handed a route rather than a proof about one. Mounted against an
    // address carrying no focus it says so and puts nothing — rather than opening the
    // previous route's run under an address that names none.
    const registry = surfacesOfThisFamily();
    const descriptor = registry.descriptorFor("workflow-phase");
    if (descriptor === undefined) {
      throw new Error('the workflows family registers no surface for "workflow-phase"');
    }
    const composed = composeWindow({ route: { kind: "workflows" } });
    const runRead = vi.spyOn(composed.context.bridge.growth, "workflowRunRead");
    await registry.preload("workflow-phase");
    await composed.paneRegistry.preload("workflow-run");
    let container: HTMLElement | undefined;
    await act(async () => {
      container = render(inWindowChrome(composed, descriptor.render(composed.context))).container;
    });
    await settle();

    expect(runRead).not.toHaveBeenCalled();
    expect(container?.textContent ?? "").toContain("names no workflow phase");
  });
});
