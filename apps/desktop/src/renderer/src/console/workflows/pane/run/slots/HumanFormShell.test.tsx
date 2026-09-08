// The console's own body for the human-form slot, over the wait the fixture parks.
//
// WHAT THESE CASES ARE ABOUT. That a phase parked on a person is ANSWERABLE from the
// pane that shows it: the prompt the run read carried is on screen, the schema draws
// its controls, a schema outside the drawn set opens the JSON editor rather than a
// refusal, the press composes the registered submit with the revision the form was
// composed against, and every refusal — the daemon's, the port's, and this surface's
// own — renders as itself.
//
// AND THE ONE SCHEMA THAT IS ANSWERABLE FROM NOWHERE. A root asking for a single value
// rather than named fields describes an answer the submit request has no member to carry,
// so the editor is not offered for it at all and the refusal stands where the act would
// have. The raw-arm cases below therefore reach the editor through an OBJECT-rooted
// schema carrying a member outside the drawn set, which is the raw arm a person can
// actually answer from.
//
// THE MOUNT IS DERIVED FROM THE FIXTURE, never written out, and the negative control at
// the end asserts the fixture really does carry a prompt and a schema, so the first case
// cannot be vacuous. The scaffolding that resolves it — and the ports, the render
// helpers, and the press — is `HumanFormShell.test-support.tsx`, shared with the suite
// beside this one; the reasons each of them is shaped the way it is live there.
//
// EVERY CASE DRIVES THE SLOT AND NOT THE SHELL, which is the only way any of them could
// be about a press: the submit, the single-flight guard and the settlement rendering are
// the SEAT's, and the shell is the composition standing in the hole. So what these cases
// assert is what a person meets — the form the schema draws, the request the press puts,
// and the answer that comes back — over the whole seat rather than over one half of it.
//
// WHAT IS DELIBERATELY NOT HERE. What the slot does as its mount MOVES — between two
// branches' waits, between the two precisions one numeric control admits, and across a
// run read that refreshes the revision under a live attempt — is
// `HumanFormShell.transitions.test.tsx`. Those cases drive the same slot through a
// re-render rather than a fresh mount, which is a different discipline from anything in
// this file, and one suite holding both was a file doing two jobs. What the seat hands a
// body another plan authors, and what it renders on that body's behalf, is
// `HumanFormSubmitChannel.test.tsx`.

import { cleanup, fireEvent, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { settle } from "../../../workflows-probe.test-support.js";
import {
  STALE_REVISION_REFUSAL,
  SUBMIT_DISPATCH_FAILURE,
  bridgeHoldingSubmits,
  bridgeThrowingSubmits,
  bridgeWatchingSubmits,
  fixtureWaitPhase,
  loadSchemaFormBody,
  pressSubmit,
  renderSlot,
} from "./HumanFormShell.test-support.js";

afterEach(() => {
  cleanup();
});

/**
 * An object-rooted schema the mapper cannot draw, so the editor opens and can be answered.
 *
 * A union-typed member rather than a `$ref`: both send the member out of the drawn set,
 * and only this one still COMPILES, so these cases exercise the raw arm rather than the
 * separate uncheckable-schema arm above it.
 */
const RAW_ARM_SCHEMA = {
  type: "object",
  properties: { when: { type: ["string", "null"] } },
} as const;

/** A root asking for a single value, which no submission can carry. */
const UNANSWERABLE_ROOT_SCHEMA = { type: "string" } as const;

// The schema form arrives as its own chunk. Resolved once here so every case below
// renders the loaded form rather than the reserved region its mount would otherwise
// suspend on — the loader memoises the load, so this is the state a second form opens in.
beforeAll(loadSchemaFormBody);

describe("a waiting phase is answerable where the pane shows it", () => {
  it("renders the prompt the run read carried and the controls its schema draws", () => {
    const container = renderSlot(fixtureWaitPhase());
    expect(container.querySelector(".meridian-schema-answer__prompt")?.textContent).toBe(
      fixtureWaitPhase().prompt,
    );
    // The three drawn kinds this fixture's schema names, read as controls rather than
    // as text: a form that rendered its schema as prose would pass a text assertion.
    // The yes-or-no is a SELECT and not a box because this phase does not REQUIRE it,
    // and only a three-state control has a state that leaves the member out.
    expect(screen.getByLabelText(/Decision/u).tagName).toBe("SELECT");
    expect(screen.getByLabelText(/Notes/u).tagName).toBe("TEXTAREA");
    expect(screen.getByLabelText(/Post the outcome to the channel/u).tagName).toBe("SELECT");
    expect(container.querySelector(".meridian-nothing--empty")).toBeNull();
  });

  it("opens the JSON editor for a schema outside the drawn set, and never a refusal", () => {
    // A.4's rule, at the surface a person actually meets: anything the mapper cannot
    // draw is answered as JSON with the mapper's own reason above it.
    const container = renderSlot({ ...fixtureWaitPhase(), inputSchema: RAW_ARM_SCHEMA });
    expect(container.querySelector(".meridian-schema-raw")).not.toBeNull();
    expect(container.querySelector(".meridian-refusal")).toBeNull();
    expect(screen.getByRole("button", { name: "Submit answer" })).not.toBeNull();
  });

  it("refuses a root that asks for a single value, and offers no act to answer it with", () => {
    // The editor is offered where a submission is possible and nowhere else: every value
    // this schema accepts is one the request cannot carry, so an editor here would invite
    // an answer whose only settlement is this surface's own refusal.
    const container = renderSlot({
      ...fixtureWaitPhase(),
      inputSchema: UNANSWERABLE_ROOT_SCHEMA,
    });

    expect(container.querySelector(".meridian-schema-raw")).toBeNull();
    expect(screen.queryByRole("button", { name: "Submit answer" })).toBeNull();
    expect(container.querySelector(".meridian-refusal")?.textContent).toContain(
      "schema-root-not-named-values",
    );
  });

  it("says so where the run reported the park and not the question", () => {
    // The additive-optional arm: a daemon below the contract revision reports the wait
    // and carries no schema, so there is nothing to compose an answer against. Absent,
    // not disabled — the control is not offered at all.
    const { inputSchema: _unsent, ...withoutTheSchema } = fixtureWaitPhase();
    const container = renderSlot(withoutTheSchema);
    expect(container.querySelector(".meridian-schema-form")).toBeNull();
    expect(screen.queryByRole("button", { name: "Submit answer" })).toBeNull();
    expect(container.querySelector(".meridian-nothing--empty")).not.toBeNull();
  });

  it("stands the reserved shell where no phase is waiting on a person", () => {
    const container = renderSlot(undefined);
    expect(container.querySelector(".meridian-schema-answer")).toBeNull();
    expect(container.querySelector(".meridian-nothing--empty")).not.toBeNull();
  });
});

describe("the press composes the registered submit", () => {
  it("carries the run, the phase and the revision the form was composed against", async () => {
    const probe = bridgeWatchingSubmits();
    const mount = fixtureWaitPhase();
    renderSlot(mount, probe.bridge);
    await act(async () => {
      pressSubmit();
    });
    await settle();

    expect(probe.requests).toStrictEqual([
      {
        workflowRunId: mount.workflowRunId,
        phaseId: mount.phaseId,
        // The wait's schema carries one OPTIONAL yes-or-no, which opens unanswered
        // rather than at the `false` a box would show — so an untouched form sends no
        // member at all, and an absent member is not the same answer as a no.
        fields: {},
        // The fixture's fresh attempt reads `0`, which is the value a falsy
        // discriminator would drop and the one the daemon adjudicates against.
        expectedRevision: 0,
      },
    ]);
  });

  it("carries a revision of one where that is what the phase reported", async () => {
    // The negative control on the case above: without it, a submit that hardcoded the
    // zero every fixture wait carries would pass it. This mount is the same wait after
    // an accepted submission, which is the state a retry is composed against.
    const probe = bridgeWatchingSubmits();
    renderSlot({ ...fixtureWaitPhase(), formRevision: 1 }, probe.bridge);
    await act(async () => {
      pressSubmit();
    });
    await settle();

    expect(probe.requests.at(0)?.expectedRevision).toBe(1);
  });

  it("settles on what the daemon answered", async () => {
    const probe = bridgeWatchingSubmits();
    renderSlot(fixtureWaitPhase(), probe.bridge);
    await act(async () => {
      pressSubmit();
    });
    await settle();

    expect(screen.getByText(/The daemon recorded this answer/u)).not.toBeNull();
  });

  it("speaks the settlement through a status live region", async () => {
    // The press leaves focus on the submit control, and the pending notice it replaces
    // says nothing on its own — so a settlement rendered as an ordinary paragraph is
    // read by nobody using a screen reader. The receipt beside the workflow-start menu
    // is the shape this follows: the sentence that lands IS the region.
    const probe = bridgeWatchingSubmits();
    renderSlot(fixtureWaitPhase(), probe.bridge);
    await act(async () => {
      pressSubmit();
    });
    await settle();

    // Both halves of what the daemon answered — that it was recorded, and how many
    // outputs came of it — inside the region rather than beside it.
    expect(screen.getByRole("status").textContent).toContain(
      "The daemon recorded this answer and one output came of it.",
    );
  });
});

describe("every refusal renders as the refusal it is", () => {
  it("renders the daemon's own code and sentence for a stale revision", async () => {
    const probe = bridgeWatchingSubmits(STALE_REVISION_REFUSAL);
    const container = renderSlot(fixtureWaitPhase(), probe.bridge);
    await act(async () => {
      pressSubmit();
    });
    await settle();

    // The daemon's message is the primary text, verbatim: it is the only account of
    // what happened to an answer somebody had already typed.
    expect(screen.getByText(STALE_REVISION_REFUSAL.message)).not.toBeNull();
    expect(container.textContent ?? "").toContain(STALE_REVISION_REFUSAL.code);
  });

  it("renders the port's own refusal where the wire is unregistered", async () => {
    // The build's true answer rather than a simulated success: the fixture serves the
    // run read and settles no mutation, so the press reaches the port and the port says
    // what it says. A mount site that composed its own sentence here would be asserting
    // a wire fact nobody checked.
    const container = renderSlot(fixtureWaitPhase());
    await act(async () => {
      pressSubmit();
    });
    await settle();

    expect(container.querySelector(".meridian-refusal")).not.toBeNull();
  });

  it("refuses an answer that is not a set of named values without spending a call", async () => {
    const probe = bridgeWatchingSubmits();
    const container = renderSlot(
      { ...fixtureWaitPhase(), inputSchema: RAW_ARM_SCHEMA },
      probe.bridge,
    );
    const editor = container.querySelector("textarea");
    if (editor === null) {
      throw new Error("the raw arm rendered no editor");
    }
    // Legal JSON and an illegal answer: the request's `fields` is an object, and an
    // array cast into it would be rejected after the round trip rather than before it.
    fireEvent.change(editor, { target: { value: "[1, 2]" } });
    await act(async () => {
      pressSubmit();
    });
    await settle();

    expect(probe.requests).toStrictEqual([]);
    expect(container.querySelector(".meridian-refusal")).not.toBeNull();
  });

  it("negative control: the same editor with an object answer does spend one", async () => {
    // Without this, the case above would pass over a form that never called the port at
    // all — including one whose submit control did nothing.
    const probe = bridgeWatchingSubmits();
    const container = renderSlot(
      { ...fixtureWaitPhase(), inputSchema: RAW_ARM_SCHEMA },
      probe.bridge,
    );
    const editor = container.querySelector("textarea");
    if (editor === null) {
      throw new Error("the raw arm rendered no editor");
    }
    fireEvent.change(editor, { target: { value: '{"decision":"approve"}' } });
    await act(async () => {
      pressSubmit();
    });
    await settle();

    expect(probe.requests.at(0)?.fields).toStrictEqual({ decision: "approve" });
  });
});

describe("an answer that is still with the daemon", () => {
  it("says so beside the control, and settles on the reply when it comes", async () => {
    const held = bridgeHoldingSubmits();
    const container = renderSlot(fixtureWaitPhase(), held.bridge);
    await act(async () => {
      pressSubmit();
    });

    // Waiting on a round trip rather than working something out: the not-loaded shape
    // and not the computing one.
    expect(container.querySelector(".meridian-nothing--not-loaded")).not.toBeNull();

    await act(async () => {
      held.serve();
    });
    await settle();

    expect(container.querySelector(".meridian-nothing--not-loaded")).toBeNull();
    expect(screen.getByText(/2 outputs came of it/u)).not.toBeNull();
  });

  it("refuses a second press out loud rather than sending the answer twice", async () => {
    // The revision token refuses a duplicate at the far end, and a form that let one
    // through would report a stale-revision failure for an answer given once.
    const held = bridgeHoldingSubmits();
    const container = renderSlot(fixtureWaitPhase(), held.bridge);
    await act(async () => {
      pressSubmit();
    });
    await act(async () => {
      pressSubmit();
    });

    expect(held.requests).toHaveLength(1);
    expect(container.querySelector(".meridian-refusal")).not.toBeNull();

    // And the key goes back, so the next press after the answer lands is not refused.
    await act(async () => {
      held.serve();
    });
    await settle();
    await act(async () => {
      pressSubmit();
    });

    expect(held.requests).toHaveLength(2);
  });
});

describe("a port that throws before it returns settles like one that rejects", () => {
  it("renders the normalized refusal rather than leaving the answer in flight", async () => {
    const probe = bridgeThrowingSubmits();
    const container = renderSlot(fixtureWaitPhase(), probe.bridge);
    await act(async () => {
      pressSubmit();
    });
    await settle();

    // The thrown text is the only account of what happened, so it reaches the screen
    // rather than going down with the exception that carried it.
    expect(container.querySelector(".meridian-refusal")?.textContent ?? "").toContain(
      SUBMIT_DISPATCH_FAILURE,
    );
    // And nothing is left saying the answer is still with the daemon: no reply is
    // coming, so a pending notice here would be a wait with no end.
    expect(container.querySelector(".meridian-nothing--not-loaded")).toBeNull();
  });

  it("gives the key back, so the next press is admitted rather than refused as a duplicate", async () => {
    // The half the settlement rendering cannot show. A throw that escapes before the
    // promise chain exists never reaches the `finally` that returns the key, so the
    // attempt is stuck in flight for the life of the form and every later press is
    // refused as a duplicate of a call that never left this window.
    const probe = bridgeThrowingSubmits();
    const container = renderSlot(fixtureWaitPhase(), probe.bridge);
    await act(async () => {
      pressSubmit();
    });
    await settle();
    await act(async () => {
      pressSubmit();
    });
    await settle();

    expect(probe.requests).toHaveLength(2);
    expect(container.textContent ?? "").not.toContain("This answer is already with the daemon.");
  });
});

describe("the mount the cases are driven from is the wire's own", () => {
  it("negative control: the fixture's waiting phase really carries a prompt and a schema", () => {
    // Without this, the first case would hold over a run read that carried neither —
    // the state this lane closed, where the form had nothing to draw and the slot said
    // the feature was unbuilt.
    const mount = fixtureWaitPhase();
    expect(typeof mount.prompt).toBe("string");
    expect(mount.inputSchema).not.toBeUndefined();
    expect(mount.formRevision).toBe(0);
  });
});
