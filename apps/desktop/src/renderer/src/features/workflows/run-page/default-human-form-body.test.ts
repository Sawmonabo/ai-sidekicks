// The console's own body for the human-form slot, over the wait the probe run parks.
//
// That a phase parked on a person is answerable from the pane that shows it: the prompt
// is on screen, the schema draws its controls, a schema outside the drawn set opens the
// JSON editor, and the press puts the submit with the revision the form was composed
// against. Every case drives the slot and not the shell, since the submit and the
// single-flight guard are the seat's. What happens as the mount moves is in
// `default-human-form-body.transitions.test.ts`; what a supplied body is handed is in
// `HumanFormSubmitBinding.test.tsx`.

import { cleanup, fireEvent, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { unhandledRejectionsDuring } from "@test/helpers/unhandled-rejection.js";
import { settle } from "../workflows-probe.test-support.js";
import {
  SUBMIT_FAILURE,
  failingSubmits,
  fixtureWaitPhase,
  holdingSubmits,
  pressSubmit,
  renderMountPoint,
  renderSwitchableMountPoint,
  resolveSchemaFormChunks,
  watchingSubmits,
} from "./default-human-form-body.test-support.js";

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

// Resolved once so every case renders a loaded form whose submit is armed.
beforeAll(resolveSchemaFormChunks);

describe("a waiting phase is answerable where the pane shows it", () => {
  it("renders the prompt the run read carried and the controls its schema draws", async () => {
    const container = await renderMountPoint(fixtureWaitPhase());
    expect(container.querySelector(".meridian-schema-answer__prompt")?.textContent).toBe(
      fixtureWaitPhase().prompt,
    );
    // Read as controls rather than text: a form that rendered its schema as prose would
    // pass a text assertion.
    expect(screen.getByLabelText(/Decision/u).tagName).toBe("SELECT");
    expect(screen.getByLabelText(/Notes/u).tagName).toBe("TEXTAREA");
  });

  it("opens the JSON editor for a schema outside the drawn set, and never a refusal", async () => {
    // Anything the mapper cannot draw is answered as JSON, not refused.
    const container = await renderMountPoint({
      ...fixtureWaitPhase(),
      inputSchema: RAW_ARM_SCHEMA,
    });
    expect(container.querySelector(".meridian-schema-raw")).not.toBeNull();
    expect(container.querySelector(".meridian-refusal")).toBeNull();
    expect(screen.getByRole("button", { name: "Submit answer" })).not.toBeNull();
  });

  it("refuses a root that asks for a single value, and offers no act to answer it with", async () => {
    // Every value this schema accepts is one the request cannot carry, so no editor.
    const container = await renderMountPoint({
      ...fixtureWaitPhase(),
      inputSchema: UNANSWERABLE_ROOT_SCHEMA,
    });

    expect(container.querySelector(".meridian-schema-raw")).toBeNull();
    expect(screen.queryByRole("button", { name: "Submit answer" })).toBeNull();
    expect(container.querySelector(".meridian-refusal")?.textContent).toContain(
      "schema-root-not-named-values",
    );
  });

  it("says so where the run reported the park and not the question", async () => {
    // A daemon below the contract revision reports the wait with no schema, so nothing
    // can be composed and the control is absent rather than disabled.
    const { inputSchema: _unsent, ...withoutTheSchema } = fixtureWaitPhase();
    const container = await renderMountPoint(withoutTheSchema);
    expect(container.querySelector(".meridian-schema-form")).toBeNull();
    expect(screen.queryByRole("button", { name: "Submit answer" })).toBeNull();
    expect(container.querySelector(".meridian-nothing--empty")).not.toBeNull();
  });

  it("draws only its empty frame where no phase is waiting on a person", async () => {
    const container = await renderMountPoint(undefined);
    expect(container.querySelector(".meridian-schema-answer")).toBeNull();
    expect(container.querySelector(".meridian-workflow__slot")?.textContent).toBe("");
  });
});

describe("the press composes the registered submit", () => {
  it("carries the run, the phase and the revision the form was composed against", async () => {
    const probe = watchingSubmits();
    const mount = fixtureWaitPhase();
    await renderMountPoint(mount, probe.submitForm);
    await act(async () => {
      pressSubmit();
    });
    await settle();

    expect(probe.requests).toStrictEqual([
      {
        workflowRunId: mount.workflowRunId,
        phaseId: mount.phaseId,
        // An untouched form sends no member: an absent one is not the same answer as a no.
        fields: {},
        // `0` is the value a falsy check would drop and the one the daemon compares.
        expectedRevision: 0,
      },
    ]);
  });

  it("carries a revision of one where that is what the phase reported", async () => {
    // Negative control: a submit that hardcoded the fixture's zero would pass the case above.
    const probe = watchingSubmits();
    await renderMountPoint({ ...fixtureWaitPhase(), formRevision: 1 }, probe.submitForm);
    await act(async () => {
      pressSubmit();
    });
    await settle();

    expect(probe.requests.at(0)?.expectedRevision).toBe(1);
  });

  it("settles on what the daemon answered", async () => {
    const probe = watchingSubmits();
    await renderMountPoint(fixtureWaitPhase(), probe.submitForm);
    await act(async () => {
      pressSubmit();
    });
    await settle();

    expect(screen.getByText(/The daemon recorded this answer/u)).not.toBeNull();
  });

  it("speaks the settlement through a status live region", async () => {
    // Focus stays on the submit control, so a plain paragraph would be silent to a
    // screen reader.
    const probe = watchingSubmits();
    await renderMountPoint(fixtureWaitPhase(), probe.submitForm);
    await act(async () => {
      pressSubmit();
    });
    await settle();

    expect(screen.getByRole("status").textContent).toContain(
      "The daemon recorded this answer and one output came of it.",
    );
  });
});

describe("an answer that is not a set of named values", () => {
  it("is refused without spending a call", async () => {
    const probe = watchingSubmits();
    const container = await renderMountPoint(
      { ...fixtureWaitPhase(), inputSchema: RAW_ARM_SCHEMA },
      probe.submitForm,
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
    // Without this, the case above would pass over a form that never called the submit at
    // all — including one whose submit control did nothing.
    const probe = watchingSubmits();
    const container = await renderMountPoint(
      { ...fixtureWaitPhase(), inputSchema: RAW_ARM_SCHEMA },
      probe.submitForm,
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
    const held = holdingSubmits();
    const container = await renderMountPoint(fixtureWaitPhase(), held.submitForm);
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
    // A duplicate let through would fail the daemon's revision check for an answer given once.
    const held = holdingSubmits();
    const container = await renderMountPoint(fixtureWaitPhase(), held.submitForm);
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

describe("a submit call that fails", () => {
  it.each([
    ["rejects", "rejects"],
    ["throws before it returns", "throws"],
  ] as const)(
    "gives the key back when the call %s, so the next press is admitted",
    async (_label, failure) => {
      const probe = failingSubmits(failure);
      const container = await renderMountPoint(fixtureWaitPhase(), probe.submitForm);
      // The failure is not caught by the form, so the runner reports it as the unhandled
      // rejection it is; the witness reads that report instead of letting it fail the run.
      const escaped = await unhandledRejectionsDuring(async () => {
        await act(async () => {
          pressSubmit();
        });
        await settle();
        await act(async () => {
          pressSubmit();
        });
        await settle();
      });

      expect(escaped).toStrictEqual([SUBMIT_FAILURE, SUBMIT_FAILURE]);
      // A key held for the life of the form would have refused the second press as a
      // duplicate of a call that ended.
      expect(probe.requests).toHaveLength(2);
      expect(container.textContent ?? "").not.toContain("This answer is already with the daemon.");
    },
  );
});

describe("a submission moves the run read only when the daemon took it", () => {
  it("records one served act for an answer the daemon recorded", async () => {
    const probe = watchingSubmits();
    const recordServedAct = vi.fn();
    await renderSwitchableMountPoint({
      phase: fixtureWaitPhase(),
      submitForm: probe.submitForm,
      recordServedAct,
    });
    await act(async () => {
      pressSubmit();
    });
    await settle();

    expect(recordServedAct).toHaveBeenCalledTimes(1);
  });

  it("records one act, and not two, when a duplicate press is refused", async () => {
    // The refused press changed nothing on the run, so it must not ask for another read.
    const held = holdingSubmits();
    const recordServedAct = vi.fn();
    await renderSwitchableMountPoint({
      phase: fixtureWaitPhase(),
      submitForm: held.submitForm,
      recordServedAct,
    });
    await act(async () => {
      pressSubmit();
    });
    await act(async () => {
      pressSubmit();
    });
    await act(async () => {
      held.serve();
    });
    await settle();

    expect(recordServedAct).toHaveBeenCalledTimes(1);
  });

  it("negative control: an answer refused for not being named values records none", async () => {
    // Without this the two cases above would hold over a form that re-armed the read on
    // every press, whether or not anything reached the daemon.
    const probe = watchingSubmits();
    const recordServedAct = vi.fn();
    const slot = await renderSwitchableMountPoint({
      phase: { ...fixtureWaitPhase(), inputSchema: RAW_ARM_SCHEMA },
      submitForm: probe.submitForm,
      recordServedAct,
    });
    const editor = slot.container.querySelector("textarea");
    if (editor === null) {
      throw new Error("the raw arm rendered no editor");
    }
    fireEvent.change(editor, { target: { value: "[1, 2]" } });
    await act(async () => {
      pressSubmit();
    });
    await settle();

    expect(slot.container.querySelector(".meridian-refusal")).not.toBeNull();
    expect(probe.requests).toStrictEqual([]);
    expect(recordServedAct).not.toHaveBeenCalled();
  });
});

describe("the mount the cases are driven from is the wire's own", () => {
  it("negative control: the probe run's waiting phase carries a prompt and a schema", async () => {
    // Without this, the first case would hold over a run read that carried neither, and
    // a form with nothing to draw.
    const mount = fixtureWaitPhase();
    expect(typeof mount.prompt).toBe("string");
    expect(mount.inputSchema).not.toBeUndefined();
    expect(mount.formRevision).toBe(0);
  });
});
