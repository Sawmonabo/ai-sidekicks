// A pane with no run, a pane whose read was refused, and a pane holding a parked
// run are three different surfaces, and the arms differ in more than their copy.
//
// The tests assert the KIND modifiers and the mounted regions rather than the
// sentences, because the copy is this family's to reword and what the arms owe is a
// rule: pick a run versus wait for a read versus act on a park, and a start
// affordance offered only where there is no run to compete with it.
//
// TWO BRIDGES, AND THE PAIR IS THE POINT. The workflows scenario scripts the run
// read, so the pane mounted against it shows what a daemon would have said; the
// flagship scenario scripts no workflow reply at all, so the same pane against it
// shows the port's typed refusal. Without the second, a green run would not
// distinguish a pane that reads from one that renders the served arm unconditionally.

import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { FLAGSHIP_SCENARIO } from "../../bridge/scenarios/flagship.js";
import { WORKFLOWS_SCENARIO } from "../../bridge/scenarios/workflows.js";
import { WORKFLOWS_PARKED_RUN } from "../../bridge/scenarios/workflow-fixture-data.js";
import type { ConsolePaneContext } from "../../workspace/index.js";
import { WorkflowRunPane } from "./WorkflowRunPane.js";

/**
 * The fields the chrome reads, and nothing else.
 *
 * Cast rather than constructed, the idiom `frame/legacy-surfaces.test.ts`
 * established: a real pane context carries three stores, one of which opens a
 * database on construction, and building all of that to hand three fields to a
 * component that reads three fields would make the setup the subject. The bridge is
 * real, because the pane now asks it something.
 */
function paneContext(
  entity: ConsolePaneContext["entity"],
  bridge: ConsoleBridge,
): ConsolePaneContext {
  return {
    kind: "workflow-run",
    entity,
    bridge,
    sessionStore: { sessionId: WORKFLOWS_PARKED_RUN.sessionId },
  } as unknown as ConsolePaneContext;
}

/** A bridge that answers the workflow reads, and one that answers nothing. */
function answeringBridge(): ConsoleBridge {
  return createFixtureBridge({ scenario: WORKFLOWS_SCENARIO });
}
function silentBridge(): ConsoleBridge {
  return createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });
}

function renderPane(context: ConsolePaneContext): HTMLElement {
  const { container } = render(<WorkflowRunPane context={context} />);
  const section = container.querySelector("section");
  if (!(section instanceof HTMLElement)) {
    throw new Error("the pane rendered no section");
  }
  return section;
}

const PARKED = { kind: "workflow-run", id: WORKFLOWS_PARKED_RUN.workflowRunId } as const;

describe("workflow run pane — the arms and what each offers", () => {
  it("reports an unaddressed pane as empty and offers the start affordance there", async () => {
    const section = renderPane(paneContext(undefined, silentBridge()));
    await waitFor(() => {
      expect(section.querySelector(".meridian-nothing--empty")).not.toBeNull();
    });
    // One slot, and it is the conversational start: a run view with no run offers
    // the start affordance, which is the empty state as designed rather than a
    // fallback.
    expect(section.querySelectorAll(".meridian-workflow__slot")).toHaveLength(1);
  });

  it("renders the port's refusal when nothing answers the run read", async () => {
    const section = renderPane(paneContext(PARKED, silentBridge()));
    await waitFor(() => {
      expect(section.querySelector(".meridian-refusal--banner")).not.toBeNull();
    });
    // Not an empty run: a refused read says nobody answered, and rendering it as a
    // run with no parked phase would assert something about the daemon that nothing
    // established.
    expect(section.querySelector(".meridian-park")).toBeNull();
  });

  it("renders every parked phase of a run the fixture answers for", async () => {
    const section = renderPane(paneContext(PARKED, answeringBridge()));
    const parkedPhaseCount = WORKFLOWS_PARKED_RUN.phaseStates.filter(
      (phase) => phase.parkReason !== undefined,
    ).length;
    await waitFor(() => {
      expect(section.querySelectorAll(".meridian-park")).toHaveLength(parkedPhaseCount);
    });
    // Counted off the fixture rather than written as a literal: the run carries two
    // park kinds at once on purpose, and a hard-coded two would keep passing if the
    // scenario dropped one of them.
    expect(parkedPhaseCount).toBeGreaterThan(1);
    expect(section.querySelector(".meridian-refusal--banner")).toBeNull();
  });

  it("offers no start affordance beside a run it already names", async () => {
    // Negative control for the first case: both would pass over a pane that mounted
    // the same regions on every arm. The addressed arm mounts the run detail and the
    // human form and NOT the start, so a second entry point never competes with the
    // run in front of the operator.
    const section = renderPane(paneContext(PARKED, answeringBridge()));
    await waitFor(() => {
      expect(section.querySelectorAll(".meridian-workflow__slot")).toHaveLength(2);
    });
  });

  it("states that neither run control is reachable, rather than hiding the question", async () => {
    // "Can I stop this run?" needs no read to answer, and no workflow mutation is
    // settled by any scenario — so both controls render a typed refusal rather than
    // disappearing and leaving an operator waiting for a button.
    const section = renderPane(paneContext(PARKED, answeringBridge()));
    await waitFor(() => {
      expect(section.querySelectorAll(".meridian-run-controls__control")).toHaveLength(2);
    });
  });
});
