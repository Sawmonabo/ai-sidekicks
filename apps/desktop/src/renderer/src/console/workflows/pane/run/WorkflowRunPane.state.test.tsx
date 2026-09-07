// A pane with no run, a pane whose read was refused, and a pane holding a parked
// run are three different surfaces, and the arms differ in more than their copy.
//
// The tests assert the KIND modifiers and the mounted regions rather than the
// sentences, because the copy is this family's to reword and what the arms owe is a
// rule: pick a run versus wait for a read versus act on a park, and a start
// affordance offered only where there is no run to compete with it.
//
// The park cards and the phase graph appear here for what the ARM renders — how many
// cards, what a card identifies, what the graph is captioned. What the graph makes of
// a park's attention is a different claim about a different derivation, and it is
// next door in `WorkflowRunPane.graph.test.tsx`.

import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { WORKFLOWS_PARKED_RUN } from "../../../bridge/scenarios/workflow-fixture-runs.js";
import {
  GRAPH_CHUNK_WAIT,
  PARKED,
  answeringBridge,
  paneContext,
  renderPane,
  silentBridge,
} from "./WorkflowRunPane.test-support.js";

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

  it("identifies the phase on every park card, so two parked branches are told apart", async () => {
    // The defect: a card rendered reason, cause and schedule and dropped the phase,
    // so a run parked on two branches showed two cards a person could not tell
    // apart. Read off the fixture rather than written out, so a scenario that
    // re-keys its phases moves the expectation with it.
    const section = renderPane(paneContext(PARKED, answeringBridge()));
    const parkedPhaseIds = WORKFLOWS_PARKED_RUN.phaseStates
      .filter((phase) => phase.parkReason !== undefined)
      .map((phase) => phase.phaseId);

    await waitFor(() => {
      expect(section.querySelectorAll(".meridian-park")).toHaveLength(parkedPhaseIds.length);
    });
    const identifiedPhases = [...section.querySelectorAll(".meridian-park__phase")].map(
      (element) => element.textContent,
    );

    // Every card carries one, and they are the run's own phase keys in the run's own
    // order. A card that identified nothing renders no such element and fails on
    // length; a card that showed a constant fails on the values, because the
    // fixture's two parks sit on two different phases.
    expect(identifiedPhases).toStrictEqual(parkedPhaseIds);
    expect(new Set(identifiedPhases).size).toBe(parkedPhaseIds.length);
  });

  it("shows that identity as a wire figure, since this read carries no authored name", async () => {
    // The run read serves no phase name, so the pane hands the badge none — and the
    // key it does have is the daemon's own string, which wears the mono provenance
    // signature rather than the face an authored name would have had.
    const section = renderPane(paneContext(PARKED, answeringBridge()));

    await waitFor(() => {
      expect(section.querySelectorAll(".meridian-park").length).toBeGreaterThan(1);
    });
    for (const identity of section.querySelectorAll(".meridian-park__phase")) {
      expect(identity.querySelector(".meridian-figure--wire")?.textContent).toBe(
        identity.textContent,
      );
      // The control on the same element: nothing was invented to sit beside the
      // identifier, so the whole slot IS the figure.
      expect(identity.querySelector(".meridian-park__phase-name")).toBeNull();
    }
  });

  it("draws the same key on the graph's nodes, in the same mono face", async () => {
    // The reason the identity is derived once: an operator reading a card is
    // matching it against a node. Two call sites reaching for a member separately
    // would each render something plausible and could disagree without anything
    // failing, which is what this asserts against.
    const section = renderPane(paneContext(PARKED, answeringBridge()));

    await waitFor(() => {
      expect(section.querySelectorAll(".meridian-phase-node__id").length).toBe(
        WORKFLOWS_PARKED_RUN.phaseStates.length,
      );
    }, GRAPH_CHUNK_WAIT);
    const nodeIdentifiers = new Set(
      [...section.querySelectorAll(".meridian-phase-node__id .meridian-figure--wire")].map(
        (element) => element.textContent,
      ),
    );

    for (const identity of section.querySelectorAll(".meridian-park__phase")) {
      expect(nodeIdentifiers).toContain(identity.textContent);
    }
    // Negative control: without this the loop would pass over a run whose cards
    // identified nothing at all, since an empty list satisfies every member claim.
    expect(section.querySelectorAll(".meridian-park__phase").length).toBeGreaterThan(1);
    // And the node's name slot stays empty, because no read reachable here fills it.
    expect(section.querySelectorAll(".meridian-phase-node__name")).toHaveLength(0);
  });

  it("captions the graph rather than inferring a topology no read carries", async () => {
    // The run read answers with an ordered phase array and no dependencies, and no
    // registered read this console can put yields the pinned definition that has
    // them. So the pane hands the graph no topology, the graph draws no connector,
    // and the caption says which of those two facts a person is looking at — where
    // before, an edge per adjacent pair drew a parallel run as a serial chain.
    const section = renderPane(paneContext(PARKED, answeringBridge()));

    await waitFor(() => {
      expect(section.querySelector(".meridian-phase-graph__caption")).not.toBeNull();
    }, GRAPH_CHUNK_WAIT);
    expect(section.querySelector(".meridian-phase-graph__caption")?.textContent ?? "").toContain(
      "has not been read here",
    );
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

  it("offers both run controls idle, with no answer standing in for a press", async () => {
    // "Can I stop this run?" needs no read to answer, so both controls are OFFERED
    // whatever the read is doing. What they are not is pre-answered: the pane used to
    // compose its own `wire-unregistered` refusal beside each button before anybody
    // pressed anything, which reported on a question nobody had put and made a
    // reachable act look broken. The press reaches the growth port now, and the
    // refusal — if there is one — is the port's, after the press.
    const section = renderPane(paneContext(PARKED, answeringBridge()));
    await waitFor(() => {
      expect(section.querySelectorAll(".meridian-workflow-run-controls__control")).toHaveLength(2);
    });
    const controls = section.querySelector(".meridian-workflow-run-controls");
    if (controls === null) {
      throw new Error("the run pane rendered no run controls");
    }
    // The discriminating half, and the one a count of two could never carry: nothing
    // in the cluster is a refusal, and both buttons can be pressed.
    expect(controls.querySelector(".meridian-refusal")).toBeNull();
    const actions = [
      ...controls.querySelectorAll<HTMLButtonElement>(".meridian-workflow-run-controls__action"),
    ];
    expect(actions.map((action) => action.textContent)).toStrictEqual([
      "Cancel this run",
      "Resume this run",
    ]);
    expect(actions.every((action) => !action.disabled)).toBe(true);
  });
});
