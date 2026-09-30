// The two mount points this directory owns: each draws only its empty frame while it has no body
// and hands a supplied body exactly what its mount promised. A body is rendered, never called, so
// its hooks belong to it; the last describe drives that across the transition where a called
// body's hooks would first join the wrapper's list.

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
  // `0` on purpose: a falsy discriminator would drop it, and a fresh attempt carries it.
  formRevision: 0,
};

/** Each mount point's unfilled rendering, as one table so a third cannot skip a case. */
const UNFILLED_MOUNT_POINTS: readonly (readonly [string, React.JSX.Element])[] = [
  ["run detail", <RunDetailMountPoint key="run-detail" workflowRunId="wfr-01" />],
  [
    "human form",
    <HumanFormMountPoint key="human-form" phase={undefined} submitForm={answerSubmit} />,
  ],
];

beforeAll(resolveSchemaFormChunks);

describe("an unfilled mount point draws only its frame", () => {
  it.each(UNFILLED_MOUNT_POINTS)("%s stands as one empty frame", (_name, element) => {
    const { container } = render(element);
    const frames = container.querySelectorAll(".meridian-workflow__mount-point");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.textContent).toBe("");
  });
});

describe("a filled mount point receives exactly what the mount promised", () => {
  // Read off the first call's first argument, not `toHaveBeenCalledWith`: React owns the
  // argument list of a component it renders, so its arity is not what this file checks.
  it("hands the run detail the run and, on an unserved read, no snapshot key at all", async () => {
    // Absent rather than present-and-empty: the key's presence is the arm the pane was on.
    // `toStrictEqual` separates an absent key from one carrying `undefined`.
    const body = vi.fn((_mount: RunDetailMount) => <p>run detail body</p>);
    const { container } = render(<RunDetailMountPoint workflowRunId="wfr-01" body={body} />);
    expect(body.mock.calls[0]?.[0]).toStrictEqual({ workflowRunId: "wfr-01" });
    expect(container.textContent).toContain("run detail body");
  });

  it("hands the run detail the served snapshot beside the run", async () => {
    // The pane supplies the snapshot rather than leaving the body to re-read it, which would
    // hold two answers to one question on one screen.
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
    // The same object, not a copy: a body renders the phases the pane renders its parks from.
    expect(body.mock.calls[0]?.[0].snapshot).toBe(PARKED_RUN);
  });

  it("hands the human form the open phase, revision included, and the bound submit", async () => {
    // The resolved phase verbatim plus the bound submit the pane keeps; `toStrictEqual` makes a
    // member the mount point did not promise as much a defect as a missing one.
    const body = vi.fn((_mount: HumanFormMount) => <p>form body</p>);
    await renderSwitchableMountPoint({ phase: OPEN_PHASE, body });
    expect(body.mock.calls[0]?.[0]).toStrictEqual({
      ...OPEN_PHASE,
      submit: expect.any(Function),
    });
  });

  it("calls no human-form body while no phase is open", async () => {
    // The body is not called at all rather than called with a placeholder: a form against an
    // unresolved phase would look answerable and be unsubmittable.
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
   * A body with state and an effect, which makes the boundary observable. Declared once because
   * a component composed on each render is a new type and React remounts it.
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
    const mountPoint = await renderSwitchableMountPoint({ phase: undefined, body });
    await mountPoint.switchTo(OPEN_PHASE);
    expect(mountPoint.container.textContent).toContain(OPEN_PHASE.phaseId);

    await mountPoint.switchTo(undefined);
    expect(mountPoint.container.querySelector(".meridian-workflow__mount-point")?.textContent).toBe(
      "",
    );
    expect(recordTeardown).toHaveBeenCalledTimes(1);

    await mountPoint.switchTo(SECOND_PHASE);
    expect(mountPoint.container.textContent).toContain(SECOND_PHASE.phaseId);
    expect(mountPoint.container.textContent).not.toContain(OPEN_PHASE.phaseId);
  });

  /**
   * The shape the wrappers avoid, reconstructed here only. Calling the body inline puts
   * its hooks into the wrapper's list. The wrapper carries one hook of its own because React
   * reads a render that calls no hook as a mount, hiding the violation until it grows one.
   */
  function directCallHumanFormMountPoint(body: (mount: HumanFormPhase) => React.JSX.Element) {
    return function DirectCallHumanFormMountPoint(props: {
      readonly phase: HumanFormPhase | undefined;
    }): React.JSX.Element {
      const openForm = props.phase === undefined ? null : body(props.phase);
      const [mountPointLabel] = useState("human form");
      return (
        <div>
          {openForm}
          {mountPointLabel}
        </div>
      );
    };
  }

  it("negative control: the direct-call shape refuses the render the phase clears on", async () => {
    // Without this, the case above would pass over a wrapper never at risk. The body's
    // `useState` sits in the wrapper's own hook list, two long while a phase is open and one
    // when it clears, and React refuses the shorter render.
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
  // addressed by run and phase; `phaseRunId` is opaque and cannot be turned back into either.

  /**
   * The request a body composes, out of the mount and the person's answers. `satisfies` checks
   * it against the registered request, so it stops compiling if the mount stops carrying what
   * the submit is addressed by.
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
        // Carried through verbatim, including the `0` a fresh attempt reads.
        expectedRevision: 0,
      },
    ]);
  });

  it("negative control: the mount without the run id cannot compose that request", async () => {
    // Without this the case above would pass over any mount at all. This is the shape the mount
    // once had: reading the run off it is a type error, so the directive below fails the build if
    // the member is dropped again.
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
