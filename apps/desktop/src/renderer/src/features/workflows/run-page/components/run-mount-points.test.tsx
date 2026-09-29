// The two slots this directory owns: each draws only its empty frame while it has no body,
// and hands a supplied body exactly what its mount promised. A supplied body is rendered
// and never called, so its hooks belong to it; the last describe drives that across the
// transition where a called body's hooks would first join the wrapper's list.

import { render } from "@testing-library/react";
import { useEffect, useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { PARKED_RUN } from "../../workflows-probe.test-support.js";
import type { WorkflowHumanFormSubmitCall } from "../human-form-submit.js";
import {
  answerSubmit,
  renderSwitchableMountPoint,
  resolveSchemaFormChunks,
} from "../default-human-form-body.test-support.js";
import { HumanFormMountPoint } from "./HumanFormMountPoint.js";
import type { HumanFormMount, HumanFormPhase } from "../human-form-mount.js";
import { RunDetailMountPoint, type RunDetailMount } from "./RunDetailMountPoint.js";

/** The submit's request, read off the call's own type rather than restated. */
type WorkflowHumanFormSubmitRequest = Parameters<WorkflowHumanFormSubmitCall>[0];

const OPEN_PHASE: HumanFormPhase = {
  workflowRunId: "019b7a10-0280-7b33-8100-4011115a0002",
  phaseRunId: "phase-run-01",
  phaseId: "review",
  // `0` on purpose: it is the value a falsy discriminator would drop, and the one a
  // fresh attempt actually carries.
  formRevision: 0,
};

/** Each slot's unfilled rendering, as one table so a third cannot skip a case. */
const UNFILLED_SLOTS: readonly (readonly [string, React.JSX.Element])[] = [
  ["run detail", <RunDetailMountPoint key="run-detail" workflowRunId="wfr-01" />],
  [
    "human form",
    <HumanFormMountPoint key="human-form" phase={undefined} submitForm={answerSubmit} />,
  ],
];

// Resolved once so every case renders a loaded form whose submit is armed.
beforeAll(resolveSchemaFormChunks);

describe("an unfilled slot draws only its frame", () => {
  it.each(UNFILLED_SLOTS)("%s stands as one empty frame", (_name, element) => {
    const { container } = render(element);
    const frames = container.querySelectorAll(".meridian-workflow__mount-point");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.textContent).toBe("");
  });
});

describe("a filled slot receives exactly what the mount promised", () => {
  // Read off the first call's first argument rather than through
  // `toHaveBeenCalledWith`: React owns the argument list of a component it renders,
  // and an assertion on its ARITY would be a claim about React rather than about the
  // mount this file is checking.
  it("hands the run detail the run and, on an unserved read, no snapshot key at all", async () => {
    // Absent rather than present-and-empty: the key's PRESENCE is the arm the pane
    // was on, so a body reading it can never be shown a run the daemon never
    // described. `toStrictEqual` is what makes that bite — it separates an absent
    // key from one carrying `undefined`.
    const body = vi.fn((_mount: RunDetailMount) => <p>run detail body</p>);
    const { container } = render(<RunDetailMountPoint workflowRunId="wfr-01" body={body} />);
    expect(body.mock.calls[0]?.[0]).toStrictEqual({ workflowRunId: "wfr-01" });
    expect(container.textContent).toContain("run detail body");
  });

  it("hands the run detail the served snapshot beside the run", async () => {
    // The obligation this slot is under is that the run pane supplies the run
    // snapshot. Handed over rather than left for the body to re-read: a body that
    // issued its own run read would put one question twice and hold two answers to
    // it on one screen.
    const body = vi.fn((_mount: RunDetailMount) => <p>run detail body</p>);
    render(
      <RunDetailMountPoint
        workflowRunId={PARKED_RUN.workflowRunId}
        snapshot={PARKED_RUN}
        body={body}
      />,
    );
    expect(body.mock.calls[0]?.[0]).toStrictEqual({
      workflowRunId: PARKED_RUN.workflowRunId,
      snapshot: PARKED_RUN,
    });
    // The same object and not a copy of it: the phases, retries and outputs a body
    // renders are the ones the pane is rendering its parks from.
    expect(body.mock.calls[0]?.[0].snapshot).toBe(PARKED_RUN);
  });

  it("hands the human form the open phase, revision included, and the seat's submit", async () => {
    // The resolved phase VERBATIM, plus the one member the pane cannot resolve: the
    // bound submit the seat keeps. `toStrictEqual` is what makes that exact — a body
    // handed a member this slot did not promise is as much a defect as a missing one.
    const body = vi.fn((_mount: HumanFormMount) => <p>form body</p>);
    await renderSwitchableMountPoint({ phase: OPEN_PHASE, body });
    expect(body.mock.calls[0]?.[0]).toStrictEqual({
      ...OPEN_PHASE,
      submit: expect.any(Function),
    });
  });

  it("calls no human-form body while no phase is open", async () => {
    // A form rendered against a phase nobody resolved would be answerable in
    // appearance and unsubmittable in fact, so the body is not called at all rather
    // than called with a placeholder.
    const body = vi.fn(() => <p>form body</p>);
    const { container } = await renderSwitchableMountPoint({ phase: undefined, body });
    expect(body).not.toHaveBeenCalled();
    expect(container.querySelector(".meridian-workflow__mount-point")?.textContent).toBe("");
  });
});

describe("a body that uses hooks keeps its own hook boundary", () => {
  const SECOND_PHASE: HumanFormPhase = {
    workflowRunId: OPEN_PHASE.workflowRunId,
    phaseRunId: "phase-run-02",
    phaseId: "sign-off",
    formRevision: 1,
  };

  /**
   * A body with state and an effect, which is what makes the boundary observable.
   *
   * Declared once rather than inside a case, because a component composed on each
   * render is a new type each time and React remounts it. The effect's teardown is the
   * fact under test: a real workflow-engine body opens a subscription there.
   */
  function statefulFormBody(recordTeardown: () => void) {
    return function StatefulFormBody(mount: HumanFormPhase): React.JSX.Element {
      const [composedAgainstPhaseId] = useState(mount.phaseId);
      useEffect(() => recordTeardown, []);
      return <p>{composedAgainstPhaseId}</p>;
    };
  }

  it("tears the body down when the phase closes and reopens it on the next one", async () => {
    const recordTeardown = vi.fn();
    const body = statefulFormBody(recordTeardown);
    const slot = await renderSwitchableMountPoint({ phase: undefined, body });
    await slot.switchTo(OPEN_PHASE);
    expect(slot.container.textContent).toContain(OPEN_PHASE.phaseId);

    await slot.switchTo(undefined);
    expect(slot.container.querySelector(".meridian-workflow__mount-point")?.textContent).toBe("");
    expect(recordTeardown).toHaveBeenCalledTimes(1);

    await slot.switchTo(SECOND_PHASE);
    expect(slot.container.textContent).toContain(SECOND_PHASE.phaseId);
    expect(slot.container.textContent).not.toContain(OPEN_PHASE.phaseId);
  });

  /**
   * The shape the wrappers no longer use, reconstructed here and nowhere in `src/`.
   *
   * Calling the body inline puts its hooks into the WRAPPER's list, which is what the
   * two controls below read off from opposite sides. The wrapper carries one hook of
   * its own because that is what makes the mixing observable at all: React reads a
   * render that calls no hook as a mount, so a wrapper with no hooks hides the
   * violation until it grows one — precisely the state these wrappers were in.
   */
  function directCallHumanFormMountPoint(body: (mount: HumanFormPhase) => React.JSX.Element) {
    return function DirectCallHumanFormMountPoint(props: {
      readonly phase: HumanFormPhase | undefined;
    }): React.JSX.Element {
      const openForm = props.phase === undefined ? null : body(props.phase);
      const [slotLabel] = useState("human form");
      return (
        <div>
          {openForm}
          {slotLabel}
        </div>
      );
    };
  }

  it("negative control: the direct-call shape refuses the render the phase clears on", async () => {
    // Without this, the case above would pass over a wrapper that had never been at
    // risk. The body's `useState` sits in the wrapper's own hook list, which is two
    // long while a phase is open and one long when it clears — and React refuses the
    // shorter render rather than guessing which hook went missing.
    const recordTeardown = vi.fn();
    const DirectCallMountPoint = directCallHumanFormMountPoint(statefulFormBody(recordTeardown));
    const { rerender } = render(<DirectCallMountPoint phase={OPEN_PHASE} />);
    const reportedErrors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(() => {
        rerender(<DirectCallMountPoint phase={undefined} />);
      }).toThrow(/hook/iu);
    } finally {
      reportedErrors.mockRestore();
    }
  });
});

describe("the human-form mount composes the registered submit on its own", () => {
  // The mount carries `workflowRunId`, `phaseId` and `formRevision` because the submit is
  // addressed by run and phase; `phaseRunId` is opaque and cannot be turned back into
  // either, so a mount without them would hand a body a form it cannot send.

  /**
   * The request a body composes, out of the mount and the person's answers.
   *
   * `satisfies` rather than an annotation, so the composition is checked against the
   * registered request while the literal keeps its own type — and so this function is
   * the compile-time half of the claim: it does not build if the mount stops carrying
   * what the submit is addressed by.
   */
  function submitRequestFor(
    mount: HumanFormPhase,
    fields: Readonly<Record<string, unknown>>,
  ): WorkflowHumanFormSubmitRequest {
    return {
      workflowRunId: mount.workflowRunId,
      phaseId: mount.phaseId,
      fields,
      expectedRevision: mount.formRevision,
    } satisfies WorkflowHumanFormSubmitRequest;
  }

  it("hands the body a mount every member of the submit is read from", async () => {
    const composed: WorkflowHumanFormSubmitRequest[] = [];
    const body = (mount: HumanFormMount): React.JSX.Element => {
      composed.push(submitRequestFor(mount, { approved: true }));
      return <p>form body</p>;
    };
    await renderSwitchableMountPoint({ phase: OPEN_PHASE, body });

    expect(composed).toStrictEqual([
      {
        workflowRunId: OPEN_PHASE.workflowRunId,
        phaseId: OPEN_PHASE.phaseId,
        fields: { approved: true },
        // Carried through verbatim, including the `0` a fresh attempt reads: the
        // daemon decides whether it is still current and the body never re-reads it.
        expectedRevision: 0,
      },
    ]);
  });

  it("negative control: the mount without the run id cannot compose that request", async () => {
    // Without this the case above would pass over any mount at all — it reads the
    // members it was given and asserts them back. This is the shape the mount HAD:
    // reading the run off it is a type error, so the directive below is what fails
    // the build the day the member is dropped again.
    const mountWithoutTheRun: Omit<HumanFormPhase, "workflowRunId"> = {
      phaseRunId: OPEN_PHASE.phaseRunId,
      phaseId: OPEN_PHASE.phaseId,
      formRevision: OPEN_PHASE.formRevision,
    };
    const composed = {
      phaseId: mountWithoutTheRun.phaseId,
      fields: {},
      expectedRevision: mountWithoutTheRun.formRevision,
      // @ts-expect-error - the submit is addressed by a run this mount does not carry
      workflowRunId: mountWithoutTheRun.workflowRunId,
    } satisfies WorkflowHumanFormSubmitRequest;

    expect(composed.workflowRunId).toBeUndefined();
  });
});
