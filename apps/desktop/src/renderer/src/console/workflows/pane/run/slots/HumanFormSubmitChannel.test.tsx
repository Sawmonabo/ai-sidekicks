// The submit channel around a body another plan authors: what it keeps, and what it
// hands over.
//
// WHAT THESE CASES CLOSE. The console's fixture shell used to hold the port call, the
// single-flight guard, the revision the attempt was composed against and the settlement
// rendering — so a body the workflow plan finally supplies would have had to re-implement
// every one of them, and the shell it replaced would have read as the template for doing
// so. They are the seat's now: a body is handed one bound act on its mount, and what came
// back is drawn beneath it.
//
// THE BODY HERE IS A PRESS AND NOTHING ELSE, deliberately. A case driven through the
// fixture shell's own form would be asking whether the schema draws a control — which is
// `HumanFormShell.test.tsx`'s question — and would pass over a channel that only worked
// for that one body. This one renders a button, calls `mount.submit`, and reports on
// nothing, which is exactly the surface an owner's body is promised.
//
// The ports, the fixture wait, the render helper and the press are
// `HumanFormShell.test-support.tsx`'s, shared with the two suites beside this one.

import { cleanup, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { settle } from "../../../workflows-probe.test-support.js";
import {
  bridgeHoldingSubmits,
  bridgeWatchingSubmits,
  fixtureWaitPhase,
  resolveSchemaFormChunks,
  pressSubmit,
  renderSwitchableSlot,
} from "./HumanFormShell.test-support.js";
import type { HumanFormMount } from "./human-form-mount.js";

afterEach(() => {
  cleanup();
});

/**
 * A body that presses the mount's own submit and renders nothing about the answer.
 *
 * Declared once outside the cases rather than composed in each, because a component
 * built inline is a new type on every render and React remounts it — the reciprocal
 * obligation `owner-slots.ts` states, and the one a supplied body is held to.
 */
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

// The schema form opens in two chunks: its own body, and the compiler the one act stays
// closed until. Both are resolved once here, so every case below renders a loaded form
// whose submit is armed rather than the reserved region its mount would otherwise suspend
// on — each loader memoises, so this is the state a second form opens in.
beforeAll(resolveSchemaFormChunks);

describe("the seat keeps the submit and the settlement, and the body keeps neither", () => {
  it("composes the registered submit out of the mount when the body presses", async () => {
    const probe = bridgeWatchingSubmits();
    const phase = fixtureWaitPhase();
    await renderSwitchableSlot({
      phase,
      bridge: probe.bridge,
      body: pressingBody({ decision: "approve" }),
    });
    await act(async () => {
      pressSubmit();
    });
    await settle();

    // Every addressing member read off the mount by the SEAT: the body passed the
    // answer alone, and could not have composed the rest without re-deriving it.
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
    const probe = bridgeWatchingSubmits();
    const { container } = await renderSwitchableSlot({
      phase: fixtureWaitPhase(),
      bridge: probe.bridge,
      body: pressingBody({ decision: "approve" }),
    });
    await act(async () => {
      pressSubmit();
    });
    await settle();

    // In the live region the settlement has always used, and inside the seat's own slot
    // rather than inside whatever the body drew.
    expect(screen.getByRole("status").textContent).toContain(
      "The daemon recorded this answer and one output came of it.",
    );
    expect(container.querySelector(".meridian-workflow__slot")?.textContent ?? "").toContain(
      "The daemon recorded this answer",
    );
  });

  it("refuses a second press out loud, so a body needs no guard of its own", async () => {
    // The single flight is the seat's too. A body that pressed twice in one frame reads
    // its own render's state both times, which is exactly why the guard is taken at
    // dispatch and exactly why it must not be the body's to take.
    //
    // Through the HELD port, because the refusal lives in the window between the press
    // and the answer: a port that served on the calling turn would publish the
    // settlement over it and the case would be asserting nothing about the guard.
    const probe = bridgeHoldingSubmits();
    const { container } = await renderSwitchableSlot({
      phase: fixtureWaitPhase(),
      bridge: probe.bridge,
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
    const probe = bridgeWatchingSubmits();
    const { container } = await renderSwitchableSlot({
      phase: fixtureWaitPhase(),
      bridge: probe.bridge,
      body: pressingBody({ decision: "approve" }),
    });
    await settle();

    expect(probe.requests).toStrictEqual([]);
    expect(screen.queryByRole("status")).toBeNull();
    expect(container.querySelector(".meridian-nothing--not-loaded")).toBeNull();
  });
});
