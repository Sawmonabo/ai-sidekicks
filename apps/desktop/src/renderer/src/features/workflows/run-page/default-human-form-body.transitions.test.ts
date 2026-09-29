// What the human-form mount point does when its mount moves underneath it: between a branching
// run's waits, between the two precisions one numeric control admits, and across a run
// read that refreshes the revision under a live attempt. Each drives the same tree
// through a re-render, since a fresh `render` would discard the state under test.

import { cleanup, fireEvent, renderHook, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { WorkflowRunSnapshot } from "@renderer/services/wire-shapes/workflow-projection.js";
import { PARKED_RUN, settle } from "../workflows-probe.test-support.js";
import {
  FIGURES_SCHEMA,
  SECOND_WAIT_PHASE_ID,
  SECOND_WAIT_PHASE_RUN_ID,
  fixtureWaitPhase,
  pressSubmit,
  renderMountPoint,
  renderSwitchableMountPoint,
  resolveSchemaFormChunks,
  watchingSubmits,
} from "./default-human-form-body.test-support.js";
import { useHumanFormSelection } from "./hooks/useHumanFormSelection.js";
import type { HumanFormPhase } from "./human-form-mount.js";

afterEach(() => {
  cleanup();
});

// Resolved once so every case renders a loaded form whose submit is armed.
beforeAll(resolveSchemaFormChunks);

describe("a run that parks two waits at once", () => {
  it("carries no part of one branch's answer onto the other branch's form", async () => {
    const first = fixtureWaitPhase();
    const second: HumanFormPhase = {
      ...first,
      phaseRunId: SECOND_WAIT_PHASE_RUN_ID,
      phaseId: SECOND_WAIT_PHASE_ID,
    };
    // One schema object across both waits: the compiled validator is memoized on it, so a
    // second object would clear the form for a reason that is not the phase.
    expect(second.inputSchema).toBe(first.inputSchema);
    const mountPoint = await renderSwitchableMountPoint({ phase: first });
    fireEvent.change(screen.getByLabelText(/Notes/u), {
      target: { value: "for the first branch" },
    });
    expect(screen.getByLabelText(/Notes/u)).toHaveProperty("value", "for the first branch");

    await mountPoint.switchTo(second);

    expect(screen.getByLabelText(/Notes/u)).toHaveProperty("value", "");
  });

  it("sends the branch on screen its own answer and never the one before it", async () => {
    // A form kept across the switch would record the first branch's typing against the
    // second branch's phase.
    const probe = watchingSubmits();
    const first = fixtureWaitPhase();
    const second: HumanFormPhase = {
      ...first,
      phaseRunId: SECOND_WAIT_PHASE_RUN_ID,
      phaseId: SECOND_WAIT_PHASE_ID,
    };
    const mountPoint = await renderSwitchableMountPoint({
      phase: first,
      submitForm: probe.submitForm,
    });
    fireEvent.change(screen.getByLabelText(/Notes/u), {
      target: { value: "for the first branch" },
    });
    await mountPoint.switchTo(second);
    await act(async () => {
      pressSubmit();
    });
    await settle();

    expect(probe.requests).toStrictEqual([
      {
        workflowRunId: second.workflowRunId,
        phaseId: second.phaseId,
        // An untouched form sends no member: an absent one is not the same answer as a no.
        fields: {},
        expectedRevision: second.formRevision,
      },
    ]);
  });
});

describe("a fractional answer to a number member", () => {
  it("reaches the daemon rather than being stopped by the control's own step", async () => {
    const probe = watchingSubmits();
    await renderMountPoint(
      { ...fixtureWaitPhase(), inputSchema: FIGURES_SCHEMA },
      probe.submitForm,
    );
    fireEvent.change(screen.getByLabelText("Ratio"), { target: { value: "1.5" } });
    await act(async () => {
      pressSubmit();
    });
    await settle();

    expect(probe.requests.at(0)?.fields).toStrictEqual({ ratio: 1.5 });
  });

  it("negative control: the same figure in an integer member is stopped before it is sent", async () => {
    // Without this, the case above would pass over a control with validation switched
    // off. The browser's own notice is not drawn by this DOM shim, but the press is stopped.
    const probe = watchingSubmits();
    await renderMountPoint(
      { ...fixtureWaitPhase(), inputSchema: FIGURES_SCHEMA },
      probe.submitForm,
    );
    fireEvent.change(screen.getByLabelText("Attempts"), { target: { value: "1.5" } });
    await act(async () => {
      pressSubmit();
    });
    await settle();

    expect(probe.requests).toStrictEqual([]);
  });
});

describe("a run read that refreshes under a live attempt", () => {
  it("sends the revision the form was composed against, not the one the refresh carried", async () => {
    // A refresh finding the same attempt at a newer revision keeps the draft. Reading the
    // revision at press time would stamp an answer composed against 0 with 1, and the
    // daemon's optimistic comparison would accept it over whatever moved the run.
    const probe = watchingSubmits();
    const composedAgainst = fixtureWaitPhase();
    const mountPoint = await renderSwitchableMountPoint({
      phase: composedAgainst,
      submitForm: probe.submitForm,
    });
    fireEvent.change(screen.getByLabelText(/Notes/u), {
      target: { value: "answered before the refresh" },
    });

    await mountPoint.switchTo({
      ...composedAgainst,
      formRevision: composedAgainst.formRevision + 1,
    });

    // The attempt did not change, so the draft stands.
    expect(screen.getByLabelText(/Notes/u)).toHaveProperty("value", "answered before the refresh");

    await act(async () => {
      pressSubmit();
    });
    await settle();

    expect(probe.requests.at(0)?.expectedRevision).toBe(composedAgainst.formRevision);
  });

  it("negative control: a new attempt captures afresh and sends the revision it opened at", async () => {
    // Without this, the case above would pass over a mount point that pinned the first
    // revision it ever saw.
    const probe = watchingSubmits();
    const first = fixtureWaitPhase();
    const mountPoint = await renderSwitchableMountPoint({
      phase: first,
      submitForm: probe.submitForm,
    });

    await mountPoint.switchTo({
      ...first,
      phaseRunId: SECOND_WAIT_PHASE_RUN_ID,
      phaseId: SECOND_WAIT_PHASE_ID,
      formRevision: first.formRevision + 1,
    });
    await act(async () => {
      pressSubmit();
    });
    await settle();

    expect(probe.requests.at(0)?.expectedRevision).toBe(first.formRevision + 1);
  });
});

describe("which of several waits has its form open", () => {
  const SECOND_RUN_ID = "019b7a10-0280-7b33-8100-4011115a0099";
  const firstWait = PARKED_RUN.phaseStates.find((phase) => phase.parkReason === "waiting-human");
  if (firstWait === undefined) {
    throw new Error("the fixture run parks no phase on a person");
  }
  const secondWait = {
    ...firstWait,
    phaseId: SECOND_WAIT_PHASE_ID,
    phaseRunId: SECOND_WAIT_PHASE_RUN_ID,
  };
  const twoWaits: WorkflowRunSnapshot = {
    ...PARKED_RUN,
    phaseStates: [...PARKED_RUN.phaseStates, secondWait],
  };

  it("opens the first wait, and a card opens its own", () => {
    const { result } = renderHook(() => useHumanFormSelection(twoWaits.workflowRunId, twoWaits));
    expect(result.current.openForm?.phaseId).toBe(firstWait.phaseId);

    act(() => {
      result.current.openFormFor(SECOND_WAIT_PHASE_ID);
    });

    expect(result.current.openForm?.phaseId).toBe(SECOND_WAIT_PHASE_ID);
    expect(result.current.isOpen(firstWait.phaseId)).toBe(false);
  });

  it("does not carry a choice onto another run that has a phase with the same id", () => {
    const otherRun: WorkflowRunSnapshot = { ...twoWaits, workflowRunId: SECOND_RUN_ID };
    const { result, rerender } = renderHook(
      ({ run }) => useHumanFormSelection(run.workflowRunId, run),
      { initialProps: { run: twoWaits } },
    );
    act(() => {
      result.current.openFormFor(SECOND_WAIT_PHASE_ID);
    });

    rerender({ run: otherRun });

    expect(result.current.openForm?.phaseId).toBe(firstWait.phaseId);
  });

  it("offers no form for a wait reported without its handle", () => {
    const { phaseRunId: _phaseRunId, ...unaddressable } = firstWait;
    const run: WorkflowRunSnapshot = {
      ...PARKED_RUN,
      phaseStates: PARKED_RUN.phaseStates.map((phase) =>
        phase.phaseId === firstWait.phaseId ? unaddressable : phase,
      ),
    };
    const { result } = renderHook(() => useHumanFormSelection(run.workflowRunId, run));

    expect(result.current.openForm).toBeUndefined();
  });
});
