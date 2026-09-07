// The re-pin picker the pane offers, and the run it offers nothing for.
//
// THE MOUNT-SITE HALF OF THE CHAIN READ. `version-chain.test.tsx` proves the hook maps
// a served reply onto choices and answers empty on every other arm; this suite proves
// the PANE puts that read at all and hands what came back to the control that draws
// the picker. A pane that called nothing would leave every case in that file green and
// still ship the surface this read replaced — an operator with no target to name.
//
// THE EXPECTATION IS READ OFF THE FIXTURE rather than written out, so a scenario that
// publishes another version of `Ship pipeline` moves the picker and this suite
// together. What is written out is the ORDER claim: the options arrive in the order the
// chain was answered in, because a console that re-ranked them would be deciding which
// version an operator sees first on evidence the wire did not send.
//
// AND THE ABSENT ARM IS A CASE OF ITS OWN. Under a bridge that scripts no workflow
// reply the run read refuses, so no pin is ever resolved, no chain is asked for, and
// the picker is ABSENT — not an empty select and not a disabled one. That is the
// state a release build renders today, and it is what the pane must keep rendering
// while the wire is unregistered.

import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { WORKFLOWS_SCENARIO_VERSION_CHAINS } from "../../../bridge/scenarios/workflow-fixture-definitions.js";
import { WORKFLOWS_PARKED_RUN } from "../../../bridge/scenarios/workflow-fixture-runs.js";
import {
  PARKED,
  answeringBridge,
  paneContext,
  renderPane,
  silentBridge,
} from "./WorkflowRunPane.test-support.js";

/** The picker's own value for "resume without re-pinning", as the DOM carries it. */
const NO_REPIN_VALUE = "";

/**
 * The chain the parked run's pin belongs to, found the way the fixture's own reply
 * finds it: by the version id, because that is the only address this read takes.
 */
function chainOfTheParkedRun(): readonly { readonly workflowVersionId: string }[] {
  const chain = Object.values(WORKFLOWS_SCENARIO_VERSION_CHAINS).find((candidate) =>
    candidate.some((entry) => entry.workflowVersionId === WORKFLOWS_PARKED_RUN.workflowVersionId),
  );
  if (chain === undefined) {
    throw new Error("the workflows fixture holds no chain for the parked run's pin");
  }
  return chain;
}

/** The picker's options as the DOM carries them, or `undefined` while there is none. */
function repinOptions(section: HTMLElement): readonly string[] | undefined {
  const picker = section.querySelector("select.meridian-workflow-run-controls__select");
  return picker instanceof HTMLSelectElement
    ? [...picker.options].map((option) => option.value)
    : undefined;
}

describe("the run pane's re-pin picker", () => {
  it("offers the chain the fixture answered, in the order it answered it", async () => {
    const section = renderPane(paneContext(PARKED, answeringBridge()));
    const answered = chainOfTheParkedRun().map((entry) => entry.workflowVersionId);

    await waitFor(() => {
      expect(repinOptions(section)).toStrictEqual([NO_REPIN_VALUE, ...answered]);
    });
    // The premise, so a chain of one would not quietly satisfy the order claim above.
    expect(answered.length).toBeGreaterThan(1);
  });

  it("marks the version the run is pinned to now, and marks one", async () => {
    const section = renderPane(paneContext(PARKED, answeringBridge()));

    await waitFor(() => {
      expect(repinOptions(section)).not.toBeUndefined();
    });
    const picker = section.querySelector("select.meridian-workflow-run-controls__select");
    if (!(picker instanceof HTMLSelectElement)) {
      throw new Error("the pane drew no re-pin picker");
    }
    const pinned = [...picker.options].filter((option) =>
      option.textContent?.includes("(pinned now)"),
    );
    expect(pinned.map((option) => option.value)).toStrictEqual([
      WORKFLOWS_PARKED_RUN.workflowVersionId,
    ]);
  });

  it("keeps the picker absent where nothing answered the run, and still offers resume", async () => {
    // The absent arm, and the reason it is a whole case: the resume CONTROL is offered
    // whatever the reads are doing — its call is addressed by the run id the pane was
    // handed — while the re-pin picker beside it is absent because no target can be
    // named. A surface that hid the button with the picker would take away the act an
    // operator came for; one that drew an empty picker would offer a choice of nothing.
    const section = renderPane(paneContext(PARKED, silentBridge()));

    await waitFor(() => {
      expect(section.querySelector(".meridian-workflow-run-controls")).not.toBeNull();
    });
    expect(repinOptions(section)).toBeUndefined();
    expect(section.querySelector(".meridian-workflow-run-controls__repin")).toBeNull();
    const resume = [...section.querySelectorAll(".meridian-workflow-run-controls__action")].some(
      (action) => action.textContent?.includes("Resume this run") === true,
    );
    expect(resume).toBe(true);
  });
});
