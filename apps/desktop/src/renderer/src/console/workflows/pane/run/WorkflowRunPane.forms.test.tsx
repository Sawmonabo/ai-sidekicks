// Reaching the form of a phase parked on a person, when more than one is.
//
// The defect this closes: a run that branches parks more than one phase on a person
// at once, and the pane resolved the FIRST addressable wait and mounted its form.
// Every other card said the wait "ends when a participant fills in and submits this
// phase's form" and offered no way to reach that form, so a parallel run could not
// be advanced from the pane that was showing it.
//
// Spied, never replaced, and here rather than in the shared harness for the reason
// the run-detail suite states about its own spy: the human form has no body anywhere
// in this repository, so which phase the pane opened reaches no markup. The park
// cards say WHICH form is open in their own words, and the spy says the pane actually
// mounted it — two different claims, and neither substitutes for the other.

import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createFixtureBridge,
  type WorkflowPhaseState,
  type WorkflowRunSnapshot,
} from "../../../bridge/index.js";
import type { ConsoleScenario } from "../../../bridge/scenario.js";
import { WORKFLOWS_PARKED_RUN } from "../../../bridge/scenarios/workflow-fixture-runs.js";
import { WORKFLOWS_SCENARIO } from "../../../bridge/scenarios/workflows.js";
import { HumanFormSlot } from "./slots/HumanFormSlot.js";
import {
  PARKED,
  answeringBridge,
  paneContext,
  renderPane,
} from "./WorkflowRunPane.test-support.js";

vi.mock(import("./slots/HumanFormSlot.js"), { spy: true });

describe("workflow run pane — reaching the form of a phase parked on a person", () => {
  afterEach(() => {
    // By name rather than `clearAllMocks`, so a case reads only the render it made.
    vi.mocked(HumanFormSlot).mockClear();
  });

  /**
   * The fixture's own human wait, which is the shape every derived phase below keeps.
   *
   * Read off the scenario rather than written out: `phaseRunId` and `formRevision` are
   * exactly what makes a wait addressable, and a hand-written phase would keep passing
   * if the fixture stopped carrying them.
   */
  function fixtureHumanWait(): WorkflowPhaseState {
    const phase = WORKFLOWS_PARKED_RUN.phaseStates.find(
      (candidate) => candidate.parkReason === "waiting-human",
    );
    if (phase === undefined) {
      throw new Error("the workflows fixture parks no phase on a person");
    }
    return phase;
  }

  /** The second branch's phase-run key, in the wire's own shape and nobody else's. */
  const SECOND_WAIT_PHASE_RUN_ID = "019b7a10-0280-7aa1-8100-701a11150009";

  /** The fixture's parked run with a SECOND phase parked on a person beside the first. */
  function runWithTwoHumanWaits(): WorkflowRunSnapshot {
    const first = fixtureHumanWait();
    return {
      ...WORKFLOWS_PARKED_RUN,
      phaseStates: WORKFLOWS_PARKED_RUN.phaseStates.flatMap((phase) =>
        phase.phaseId === first.phaseId
          ? [
              phase,
              {
                ...first,
                phaseId: `${first.phaseId}-second-branch`,
                phaseRunId: SECOND_WAIT_PHASE_RUN_ID,
              },
            ]
          : [phase],
      ),
    };
  }

  /** The same run with its sole human wait reported without the handle to answer it. */
  function runWithAnUnaddressableWait(): WorkflowRunSnapshot {
    const first = fixtureHumanWait();
    return {
      ...WORKFLOWS_PARKED_RUN,
      phaseStates: WORKFLOWS_PARKED_RUN.phaseStates.map((phase) => {
        if (phase.phaseId !== first.phaseId) {
          return phase;
        }
        // Exactly the two members dropped, and everything else carried through
        // untouched: the park is real and the form is not reachable from what
        // arrived, which is what an older daemon sends. Subtracted rather than
        // rebuilt member by member, so this stays a case about two absent fields
        // even after the phase shape grows a third.
        const { phaseRunId: _phaseRunId, formRevision: _formRevision, ...unaddressable } = phase;
        return unaddressable;
      }),
    };
  }

  /**
   * A scenario answering the run read with one snapshot, driving the REAL fixture port.
   *
   * The idiom `run-snapshot.test.tsx` established. Scripting the reply rather than
   * replacing the port keeps the pane's read on the same path every other case here
   * exercises, so what these cases observe is the pane and not a stand-in.
   */
  function scenarioServingRun(run: WorkflowRunSnapshot): ConsoleScenario {
    return {
      ...WORKFLOWS_SCENARIO,
      id: "workflow-run-pane-human-waits",
      replies: [{ call: "workflow.runRead", result: run }],
    };
  }

  function renderRun(run: WorkflowRunSnapshot): HTMLElement {
    return renderPane(
      paneContext(PARKED, createFixtureBridge({ scenario: scenarioServingRun(run) })),
    );
  }

  /** The phase whose form the pane actually mounted, on the latest render it made. */
  function mountedFormPhaseId(): string | undefined {
    return vi.mocked(HumanFormSlot).mock.calls.at(-1)?.[0].phase?.phaseId;
  }

  function routeControls(section: HTMLElement): readonly Element[] {
    return [...section.querySelectorAll(".meridian-park__form-action")];
  }

  function routeSentences(section: HTMLElement): readonly string[] {
    return [...section.querySelectorAll(".meridian-park__form-state")].map(
      (element) => element.textContent ?? "",
    );
  }

  it("gives every addressable wait a route, and opens the first of them", async () => {
    const run = runWithTwoHumanWaits();
    const section = renderRun(run);
    const [firstWait, secondWait] = run.phaseStates.filter(
      (phase) => phase.parkReason === "waiting-human",
    );
    if (firstWait === undefined || secondWait === undefined) {
      throw new Error("the derived run does not park two phases on a person");
    }

    await waitFor(() => {
      expect(section.querySelectorAll(".meridian-park")).toHaveLength(3);
    });

    // Both human waits carry a route line and the third park carries none — a phase
    // waiting on provider capacity has no form to reach, so a control there would
    // point nowhere. Two lines, one of each kind: the open one says so, and the other
    // is the control that was missing entirely.
    expect(routeControls(section)).toHaveLength(1);
    expect(routeSentences(section)).toStrictEqual(["This phase’s form is open below."]);
    expect(mountedFormPhaseId()).toBe(firstWait.phaseId);
  });

  it("mounts the second branch's form when that card asks for it", async () => {
    const run = runWithTwoHumanWaits();
    const section = renderRun(run);
    const [firstWait, secondWait] = run.phaseStates.filter(
      (phase) => phase.parkReason === "waiting-human",
    );
    if (firstWait === undefined || secondWait === undefined) {
      throw new Error("the derived run does not park two phases on a person");
    }

    await waitFor(() => {
      expect(routeControls(section)).toHaveLength(1);
    });
    const [openTheSecond] = routeControls(section);
    if (openTheSecond === undefined) {
      throw new Error("the second branch's card offered no route");
    }
    fireEvent.click(openTheSecond);

    // The pane mounts the phase the card named, and the two cards swap which of them
    // has the control — so the surface says which form is open rather than leaving an
    // operator to infer it from what is rendered underneath.
    expect(mountedFormPhaseId()).toBe(secondWait.phaseId);
    expect(routeControls(section)).toHaveLength(1);
    expect(routeSentences(section)).toStrictEqual(["This phase’s form is open below."]);
  });

  it("leaves a run with a single wait exactly as it was: that form, already open", async () => {
    // The fixture's own parked run, which parks one phase on a person. Nothing here
    // asks for anything, and the pane mounts the wait it always mounted.
    const section = renderPane(paneContext(PARKED, answeringBridge()));

    await waitFor(() => {
      expect(section.querySelectorAll(".meridian-park").length).toBeGreaterThan(1);
    });
    expect(mountedFormPhaseId()).toBe(fixtureHumanWait().phaseId);
    expect(routeControls(section)).toHaveLength(0);
    expect(routeSentences(section)).toStrictEqual(["This phase’s form is open below."]);
  });

  it("negative control: a wait reported without its handle says why, and mounts nothing", async () => {
    // `phaseRunId` and `formRevision` are additive-optional on an already-published
    // shape, so their absence means an older daemon rather than a phase without a
    // form. Without this case, the three above would pass over a pane that offered a
    // control on every human wait and composed a mount out of nothing — answerable in
    // appearance and unsubmittable in fact.
    const section = renderRun(runWithAnUnaddressableWait());

    await waitFor(() => {
      expect(section.querySelectorAll(".meridian-park")).toHaveLength(2);
    });
    expect(routeControls(section)).toHaveLength(0);
    expect(routeSentences(section)).toHaveLength(1);
    expect(routeSentences(section)[0] ?? "").toContain("cannot be opened here");
    expect(mountedFormPhaseId()).toBeUndefined();
  });
});
