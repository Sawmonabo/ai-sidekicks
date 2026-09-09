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
// SO DOES THE REFRESHED REVISION, which is the same shape again and the sharpest case of
// it: the mount moves, the ATTEMPT does not, and the answer somebody typed is still on
// screen. What the submit carries then is a fact about when the form was composed rather
// than about the newest run read, and only a re-render can ask that question.
//
// The ports, the fixture mount, the render helpers and the press are
// `HumanFormShell.test-support.tsx`'s, shared with the suite beside this one.

import { cleanup, fireEvent, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { settle } from "../../../workflows-probe.test-support.js";
import {
  FIGURES_SCHEMA,
  SECOND_WAIT_PHASE_ID,
  SECOND_WAIT_PHASE_RUN_ID,
  bridgeWatchingSubmits,
  fixtureWaitPhase,
  loadSchemaFormBody,
  pressSubmit,
  renderSlot,
  renderSwitchableSlot,
} from "./HumanFormShell.test-support.js";
import type { HumanFormPhase } from "./human-form-mount.js";

afterEach(() => {
  cleanup();
});

// The schema form arrives as its own chunk. Resolved once here so every case below
// renders the loaded form rather than the reserved region its mount would otherwise
// suspend on — the loader memoises the load, so this is the state a second form opens in.
beforeAll(loadSchemaFormBody);

describe("a run that parks two waits at once", () => {
  it("carries no part of one branch's answer onto the other branch's form", async () => {
    const first = fixtureWaitPhase();
    const second: HumanFormPhase = {
      ...first,
      phaseRunId: SECOND_WAIT_PHASE_RUN_ID,
      phaseId: SECOND_WAIT_PHASE_ID,
    };
    // ONE schema object across both waits, deliberately. The plan and the compiled
    // validator are memoised on the schema, so a second object would clear the form for
    // a reason that is not the phase and this case would pass over the defect it is
    // about — two branches asking the same question is also when the confusion is worst.
    expect(second.inputSchema).toBe(first.inputSchema);
    const slot = await renderSwitchableSlot({ phase: first });
    fireEvent.change(screen.getByLabelText(/Notes/u), {
      target: { value: "for the first branch" },
    });
    expect(screen.getByLabelText(/Notes/u)).toHaveProperty("value", "for the first branch");

    await slot.switchTo(second);

    expect(screen.getByLabelText(/Notes/u)).toHaveProperty("value", "");
  });

  it("sends the branch on screen its own answer and never the one before it", async () => {
    // The harm the case above is about, at the wire: a form kept across the switch would
    // record the first branch's typing against the second branch's phase.
    const probe = bridgeWatchingSubmits();
    const first = fixtureWaitPhase();
    const second: HumanFormPhase = {
      ...first,
      phaseRunId: SECOND_WAIT_PHASE_RUN_ID,
      phaseId: SECOND_WAIT_PHASE_ID,
    };
    const slot = await renderSwitchableSlot({ phase: first, bridge: probe.bridge });
    fireEvent.change(screen.getByLabelText(/Notes/u), {
      target: { value: "for the first branch" },
    });
    await slot.switchTo(second);
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
    await renderSlot({ ...fixtureWaitPhase(), inputSchema: FIGURES_SCHEMA }, probe.bridge);
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
    await renderSlot({ ...fixtureWaitPhase(), inputSchema: FIGURES_SCHEMA }, probe.bridge);
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
    // THE DEFECT THIS CASE EXISTS FOR. A refresh that finds the SAME waiting attempt at a
    // newer revision re-renders this slot with a moved `formRevision` while the draft
    // survives — it is keyed on the attempt, which has not changed. A submit that read
    // the member at press time would stamp an answer composed against revision 0 with
    // revision 1, and the daemon's optimistic comparison would find it current and
    // accept it over whatever had moved the run. The captured value is refused instead,
    // which is the whole point of the token.
    const probe = bridgeWatchingSubmits();
    const composedAgainst = fixtureWaitPhase();
    const slot = await renderSwitchableSlot({ phase: composedAgainst, bridge: probe.bridge });
    fireEvent.change(screen.getByLabelText(/Notes/u), {
      target: { value: "answered before the refresh" },
    });

    await slot.switchTo({ ...composedAgainst, formRevision: composedAgainst.formRevision + 1 });

    // The attempt did not change, so neither did the form: the draft standing here is
    // what makes the stale revision a real hazard rather than a theoretical one.
    expect(screen.getByLabelText(/Notes/u)).toHaveProperty("value", "answered before the refresh");

    await act(async () => {
      pressSubmit();
    });
    await settle();

    expect(probe.requests.at(0)?.expectedRevision).toBe(composedAgainst.formRevision);
  });

  it("negative control: a new attempt captures afresh and sends the revision it opened at", async () => {
    // Without this, the case above would hold over a surface that had simply pinned the
    // first revision it ever saw — which would send a stale number for every later wait.
    const probe = bridgeWatchingSubmits();
    const first = fixtureWaitPhase();
    const slot = await renderSwitchableSlot({ phase: first, bridge: probe.bridge });

    await slot.switchTo({
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
