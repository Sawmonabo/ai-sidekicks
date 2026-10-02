// The console's own body for the human-form mount point, over the wait the probe run parks: the
// press puts the submit with the answer on screen and the revision the form was composed against,
// once, and a failed call gives the key back. Cases drive the mount point, since the submit and
// single-flight guard are the binding's; the moving cases re-render one tree, since a fresh
// `render` would discard the state under test.

import { cleanup, fireEvent, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { unhandledRejectionsDuring } from "@test/helpers/unhandled-rejection.js";
import { settle } from "../workflows-probe.test-support.js";
import {
  FIGURES_SCHEMA,
  SECOND_WAIT_PHASE_ID,
  SECOND_WAIT_PHASE_RUN_ID,
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
import type { HumanFormPhase } from "./human-form-mount.js";

afterEach(() => {
  cleanup();
});

/**
 * An object-rooted schema the mapper cannot draw, so the editor opens and can be answered. It
 * uses a union-typed member rather than a `$ref` because that still compiles, exercising the raw
 * arm rather than the uncheckable-schema arm.
 */
const RAW_ARM_SCHEMA = {
  type: "object",
  properties: { when: { type: ["string", "null"] } },
} as const;

// Resolved once so every case renders a loaded form whose submit is armed.
beforeAll(resolveSchemaFormChunks);

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

  it("sends an object answer typed into the JSON editor", async () => {
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

  it("sends a fractional answer to a number member rather than stopping it", async () => {
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
});

describe("an answer that is still with the daemon", () => {
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

    // The key goes back, so the next press after the answer lands is not refused.
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
      // The form does not catch the failure, so the runner reports an unhandled rejection; the
      // case reads that report instead of letting it fail the run.
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
      // A key held for the form's life would have refused the second press as a duplicate.
      expect(probe.requests).toHaveLength(2);
      expect(container.textContent ?? "").not.toContain(
        "This answer is already with the background service.",
      );
    },
  );
});

describe("the mount moves under the form", () => {
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
});
