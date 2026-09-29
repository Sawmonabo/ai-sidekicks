// The submit channel around a supplied body: what it keeps, and what it hands over. The body
// here is a press and nothing else, so the cases hold for any body and not only for the
// console's own shell.

import { cleanup, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { settle } from "../../workflows-probe.test-support.js";
import {
  fixtureWaitPhase,
  holdingSubmits,
  pressSubmit,
  renderSwitchableMountPoint,
  resolveSchemaFormChunks,
  watchingSubmits,
} from "../default-human-form-body.test-support.js";
import type { HumanFormMount } from "../human-form-mount.js";

afterEach(() => {
  cleanup();
});

/** A body that presses the mount's own submit and renders nothing about the answer. */
function pressingBody(answer: Readonly<Record<string, unknown>>) {
  return function PressingFormBody(mount: HumanFormMount): React.JSX.Element {
    return (
      <button
        type="button"
        onClick={() => {
          mount.submit(answer);
        }}
      >
        Submit answer
      </button>
    );
  };
}

// Resolved once so every case renders a loaded form whose submit is armed.
beforeAll(resolveSchemaFormChunks);

describe("the seat keeps the submit and the settlement, and the body keeps neither", () => {
  it("composes the registered submit out of the mount when the body presses", async () => {
    const probe = watchingSubmits();
    const phase = fixtureWaitPhase();
    await renderSwitchableMountPoint({
      phase,
      submitForm: probe.submitForm,
      body: pressingBody({ decision: "approve" }),
    });
    await act(async () => {
      pressSubmit();
    });
    await settle();

    // The body passed the answer alone; the seat read every addressing member.
    expect(probe.requests).toStrictEqual([
      {
        workflowRunId: phase.workflowRunId,
        phaseId: phase.phaseId,
        fields: { decision: "approve" },
        expectedRevision: phase.formRevision,
      },
    ]);
  });

  it("renders what the daemon answered beneath a body that renders no outcome at all", async () => {
    const probe = watchingSubmits();
    const { container } = await renderSwitchableMountPoint({
      phase: fixtureWaitPhase(),
      submitForm: probe.submitForm,
      body: pressingBody({ decision: "approve" }),
    });
    await act(async () => {
      pressSubmit();
    });
    await settle();

    // In the live region, inside the seat's own slot rather than the body's.
    expect(screen.getByRole("status").textContent).toContain(
      "The background service recorded this answer and one output came of it.",
    );
    expect(container.querySelector(".meridian-workflow__mount-point")?.textContent ?? "").toContain(
      "The background service recorded this answer",
    );
  });

  it("refuses a second press out loud, so a body needs no guard of its own", async () => {
    // A body pressing twice in one frame reads the same render's state both times, so
    // the guard is the seat's, taken at dispatch.
    //
    // Held, because the refusal lives between the press and the answer.
    const probe = holdingSubmits();
    const { container } = await renderSwitchableMountPoint({
      phase: fixtureWaitPhase(),
      submitForm: probe.submitForm,
      body: pressingBody({ decision: "approve" }),
    });
    await act(async () => {
      pressSubmit();
      pressSubmit();
    });
    await settle();

    expect(probe.requests).toHaveLength(1);
    expect(container.querySelector(".meridian-refusal")?.textContent ?? "").toContain(
      "submit-already-in-flight",
    );
  });

  it("negative control: a body that never presses leaves the seat with nothing to say", async () => {
    // Without this, the cases above would hold over a seat that drew its settlement
    // unconditionally — which would report an answer nobody had given.
    const probe = watchingSubmits();
    const { container } = await renderSwitchableMountPoint({
      phase: fixtureWaitPhase(),
      submitForm: probe.submitForm,
      body: pressingBody({ decision: "approve" }),
    });
    await settle();

    expect(probe.requests).toStrictEqual([]);
    expect(screen.queryByRole("status")).toBeNull();
    expect(container.querySelector(".meridian-nothing--not-loaded")).toBeNull();
  });
});
