// What the human-form slot does when its mount MOVES underneath it.
//
// A SUITE OF ITS OWN BECAUSE THE DISCIPLINE IS DIFFERENT. The cases beside this file
// mount one wait and ask whether it is answerable. These drive the SAME tree through a
// re-render — a branching run parks several phases at once and the pane moves this one
// slot from one to the next without unmounting it, so a fresh `render` would prove
// nothing, having discarded the state the case is asking about.
//
// AND THE NUMBER PAIR BELONGS WITH THEM. It is the same question one level down: a
// `number` member and an `integer` member draw one control and differ only in the
// precision it admits, so what a person may type into it moves with the schema and each
// arm is the other's negative control.
//
// The ports, the fixture mount, the render helpers and the press are
// `HumanFormShell.test-support.tsx`'s, shared with the suite beside this one.

import { cleanup, fireEvent, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { settle } from "../../../workflows-probe.test-support.js";
import {
  FIGURES_SCHEMA,
  SECOND_WAIT_PHASE_ID,
  SECOND_WAIT_PHASE_RUN_ID,
  bridgeWatchingSubmits,
  fixtureWaitMount,
  pressSubmit,
  renderSlot,
  renderSwitchableSlot,
} from "./HumanFormShell.test-support.js";
import type { HumanFormMount } from "./human-form-mount.js";

afterEach(() => {
  cleanup();
});

describe("a run that parks two waits at once", () => {
  it("carries no part of one branch's answer onto the other branch's form", () => {
    const first = fixtureWaitMount();
    const second: HumanFormMount = {
      ...first,
      phaseRunId: SECOND_WAIT_PHASE_RUN_ID,
      phaseId: SECOND_WAIT_PHASE_ID,
    };
    // ONE schema object across both waits, deliberately. The plan and the compiled
    // validator are memoised on the schema, so a second object would clear the form for
    // a reason that is not the phase and this case would pass over the defect it is
    // about — two branches asking the same question is also when the confusion is worst.
    expect(second.inputSchema).toBe(first.inputSchema);
    const slot = renderSwitchableSlot(first);
    fireEvent.change(screen.getByLabelText(/Notes/u), {
      target: { value: "for the first branch" },
    });
    expect(screen.getByLabelText(/Notes/u)).toHaveProperty("value", "for the first branch");

    slot.switchTo(second);

    expect(screen.getByLabelText(/Notes/u)).toHaveProperty("value", "");
  });

  it("sends the branch on screen its own answer and never the one before it", async () => {
    // The harm the case above is about, at the wire: a form kept across the switch would
    // record the first branch's typing against the second branch's phase.
    const probe = bridgeWatchingSubmits();
    const first = fixtureWaitMount();
    const second: HumanFormMount = {
      ...first,
      phaseRunId: SECOND_WAIT_PHASE_RUN_ID,
      phaseId: SECOND_WAIT_PHASE_ID,
    };
    const slot = renderSwitchableSlot(first, probe.bridge);
    fireEvent.change(screen.getByLabelText(/Notes/u), {
      target: { value: "for the first branch" },
    });
    slot.switchTo(second);
    await act(async () => {
      pressSubmit();
    });
    await settle();

    expect(probe.requests).toStrictEqual([
      {
        workflowRunId: second.workflowRunId,
        phaseId: second.phaseId,
        // The wait's schema carries one OPTIONAL yes-or-no, which opens unanswered
        // rather than at the `false` a box would show — so an untouched form sends no
        // member at all, and an absent member is not the same answer as a no.
        fields: {},
        expectedRevision: second.formRevision,
      },
    ]);
  });
});

describe("a fractional answer to a number member", () => {
  it("reaches the daemon rather than being stopped by the control's own step", async () => {
    const probe = bridgeWatchingSubmits();
    renderSlot({ ...fixtureWaitMount(), inputSchema: FIGURES_SCHEMA }, probe.bridge);
    fireEvent.change(screen.getByLabelText("Ratio"), { target: { value: "1.5" } });
    await act(async () => {
      pressSubmit();
    });
    await settle();

    expect(probe.requests.at(0)?.fields).toStrictEqual({ ratio: 1.5 });
  });

  it("negative control: the same figure in an integer member is stopped before it is sent", async () => {
    // Without this, the case above would hold over a control that had simply switched
    // constraint validation off. `integer` and the platform's whole-number step say one
    // thing, so the press is refused — by the browser's own validation notice, which
    // this DOM shim does not draw but every shipped runtime does.
    const probe = bridgeWatchingSubmits();
    renderSlot({ ...fixtureWaitMount(), inputSchema: FIGURES_SCHEMA }, probe.bridge);
    fireEvent.change(screen.getByLabelText("Attempts"), { target: { value: "1.5" } });
    await act(async () => {
      pressSubmit();
    });
    await settle();

    expect(probe.requests).toStrictEqual([]);
  });
});
