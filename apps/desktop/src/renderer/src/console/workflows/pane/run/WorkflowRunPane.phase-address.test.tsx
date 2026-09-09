// The second half of the phase deep link: which form is open once the pane is mounted.
//
// The defect this closes: `routing/routes.ts` has parsed
// `#/session/<sid>/workflow/<rid>/phase/<pid>` into a workspace route carrying that
// phase since the grammar shipped, and nothing outside `routing/` read the member. A
// person following such a link reached a surface that knew the phase and never told
// anybody, so the address advertised a focus it did not perform.
//
// WHAT IS ASSERTED HERE IS THE SEED AND NOT THE RESOLUTION. `human-form-selection.ts`
// already resolves whichever wait is open against the CURRENT snapshot, and these cases
// do not restate that: they check that the route reaches that resolution as its initial
// value, that a focus naming another run reaches it as nothing, and that a person
// pressing a card afterwards outranks the link. The surface that opens the pane at the
// right RUN is `workflows/WorkflowPhaseLinkSurface.tsx` and is tested beside itself.
//
// The spy is the form slot's, for `WorkflowRunPane.forms.test.tsx`'s reason: the human
// form has no body in this repository, so which phase the pane opened reaches no markup.

import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createFixtureBridge,
  type WorkflowPhaseState,
  type WorkflowRunSnapshot,
} from "../../../bridge/index.js";
import { WORKFLOWS_PARKED_RUN } from "../../../bridge/scenario/workflows/runs.js";
import type { ConsoleRoute } from "../../../routing/index.js";
import { HumanFormSlot } from "./slots/HumanFormSlot.js";
import {
  PARKED,
  humanWaitsOf,
  mountedFormPhaseId,
  paneContext,
  renderPane,
  runWithTwoHumanWaits,
  scenarioServingRun,
} from "./WorkflowRunPane.test-support.js";

vi.mock(import("./slots/HumanFormSlot.js"), { spy: true });

describe("workflow run pane — the phase a deep link named", () => {
  afterEach(() => {
    // By name rather than `clearAllMocks`, so a case reads only the render it made.
    vi.mocked(HumanFormSlot).mockClear();
  });

  /** The workspace address for one phase of one run, as `parseRoute` builds it. */
  function phaseRoute(workflowRunId: string, phaseId: string): ConsoleRoute {
    return {
      kind: "workspace",
      sessionId: WORKFLOWS_PARKED_RUN.sessionId,
      workflowPhase: { workflowRunId, phaseId },
    };
  }

  /**
   * One run on screen, under whatever route the window committed.
   *
   * Every case here serves the BRANCHING run, because a run with a single wait cannot
   * tell "opened the phase it was asked for" apart from "opened the only wait there
   * was" — which is what the pre-fix pane did on every one of these addresses.
   */
  function renderRun(run: WorkflowRunSnapshot, committedRoute?: ConsoleRoute): HTMLElement {
    const scenario = scenarioServingRun(run, "workflow-run-pane-phase-address");
    return renderPane(
      paneContext(PARKED, createFixtureBridge({ scenario }), undefined, committedRoute),
    );
  }

  async function waitForEveryParkCard(section: HTMLElement): Promise<void> {
    await waitFor(() => {
      expect(section.querySelectorAll(".meridian-park")).toHaveLength(3);
    });
  }

  /** The branching run's two human waits, refusing rather than passing on one. */
  function bothWaitsOf(
    run: WorkflowRunSnapshot,
  ): readonly [WorkflowPhaseState, WorkflowPhaseState] {
    const [firstWait, secondWait] = humanWaitsOf(run);
    if (firstWait === undefined || secondWait === undefined) {
      throw new Error("the derived run does not park two phases on a person");
    }
    return [firstWait, secondWait];
  }

  it("opens the phase the address named rather than the first wait", async () => {
    // The SECOND wait deliberately: the first is what this run resolves to when nobody
    // names one, so a link naming it would pass over a pane that read no route at all.
    const run = runWithTwoHumanWaits();
    const [, secondWait] = bothWaitsOf(run);
    const section = renderRun(run, phaseRoute(run.workflowRunId, secondWait.phaseId));

    await waitForEveryParkCard(section);
    expect(mountedFormPhaseId()).toBe(secondWait.phaseId);
  });

  it("negative control: with no phase on the route the first wait opens", async () => {
    // The frame store's default route names no workflow phase, which is every other
    // run-pane case in this directory. Without this, the case above would pass over a
    // pane that always mounted the second wait for reasons of its own.
    const run = runWithTwoHumanWaits();
    const [firstWait] = bothWaitsOf(run);
    const section = renderRun(run);

    await waitForEveryParkCard(section);
    expect(mountedFormPhaseId()).toBe(firstWait.phaseId);
  });

  it("negative control: a focus naming another run supplies nothing", async () => {
    // The frame carries ONE route for every pane in the window, so a deck showing run A
    // beside a link that named a phase of run B must not ask A's phases about B's id.
    // The phase ids here are the definition's and collide across runs by construction,
    // so an unguarded read would have found this exact id and opened it.
    const run = runWithTwoHumanWaits();
    const [firstWait, secondWait] = bothWaitsOf(run);
    const section = renderRun(
      run,
      phaseRoute("019b7a10-0280-7aa1-8100-7010000000ff", secondWait.phaseId),
    );

    await waitForEveryParkCard(section);
    expect(mountedFormPhaseId()).toBe(firstWait.phaseId);
  });

  it("negative control: a phase this run does not park on a person falls back", async () => {
    // A link is followed minutes after it was written, and by then the phase it named
    // may have resumed. The pane lands on the run rather than on nothing, which is the
    // resolution a stale card press already gets.
    const run = runWithTwoHumanWaits();
    const [firstWait] = bothWaitsOf(run);
    const section = renderRun(run, phaseRoute(run.workflowRunId, "a-phase-that-has-since-resumed"));

    await waitForEveryParkCard(section);
    expect(mountedFormPhaseId()).toBe(firstWait.phaseId);
  });

  it("lets the card a person presses supersede the link", async () => {
    // The seed is an initial value and not an override: the person is looking at the
    // pane and the link is not. Without this, the link could have been read every
    // render and the park cards would have stopped working on a deep-linked pane.
    const run = runWithTwoHumanWaits();
    const [firstWait, secondWait] = bothWaitsOf(run);
    const section = renderRun(run, phaseRoute(run.workflowRunId, secondWait.phaseId));

    await waitForEveryParkCard(section);
    const [openTheOther] = [...section.querySelectorAll(".meridian-park__form-action")];
    if (!(openTheOther instanceof HTMLElement)) {
      throw new Error("the other branch's card offered no route");
    }
    fireEvent.click(openTheOther);

    expect(mountedFormPhaseId()).toBe(firstWait.phaseId);
  });
});
