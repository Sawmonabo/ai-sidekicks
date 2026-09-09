// The mounted pane re-reads because the daemon RECORDED an answer to a parked phase.
//
// THE DEFECT THESE CLOSE. A served `workflowHumanFormSubmit` settled the form's own
// outcome and nothing else: the round `useWorkflowRunSnapshot` is keyed on is advanced
// by the run controls and by the session's own frames, and a submission reached neither.
// So a pane whose answer the daemon had accepted went on rendering the parked phase and
// its submit form — under a line saying the daemon had recorded the answer — until some
// other reason happened to put the read again.
//
// AND NO FRAME IS DELIVERED HERE, deliberately. The session store these cases mount over
// is subscribed to nothing, so the live-round half of the pane's round cannot advance and
// the only thing that can put a second read is the submission itself. That is also the
// shape of the failure being closed: a workflow frame that is delayed, dropped, or not
// yet emitted by a daemon whose `workflow.*` kinds `packages/contracts` still registers
// none of.
//
// THE INSTRUMENTS ARE THE COUNT AND THE DOM, and neither substitutes for the other. The
// count tells a re-read apart from a re-render; the card that goes says the second answer
// reached the screen rather than being fetched and dropped.
//
// The moving-run bridge, the answered run and the park census are the run-pane harness's,
// shared with the live-round suite that moves the same run by another route; the press is
// the human-form slot's own, so these cases drive the button an operator does.

import { waitFor } from "@testing-library/react";
import { act } from "react";
import { beforeAll, describe, expect, it } from "vitest";

import type { ConsoleBridge, GrowthPort } from "../../../bridge/index.js";
import { WORKFLOWS_PARKED_RUN } from "../../../bridge/scenarios/workflow-fixture-runs.js";
import type { WireErrorEnvelope } from "../../../core/index.js";
import { settle } from "../../workflows-probe.test-support.js";
import {
  STALE_REVISION_REFUSAL,
  loadSchemaFormBody,
  pressSubmit,
} from "./slots/HumanFormShell.test-support.js";
import {
  PARKED,
  RUN_WITH_HUMAN_PARK_ANSWERED,
  bridgeWhoseRunMoves,
  paneContext,
  parkedPhaseCountOf,
  renderPane,
  type MovingRunBridge,
} from "./WorkflowRunPane.test-support.js";

/** One park card. Counted rather than read, because what moves is how many stand. */
const PARK_SELECTOR = ".meridian-park";

/** How many of the fixture run's phases are parked when the pane first reads it. */
const PARKED_PHASE_COUNT = parkedPhaseCountOf(WORKFLOWS_PARKED_RUN);

/** And how many stand once the human park has been answered. One fewer. */
const ANSWERED_PARK_COUNT = parkedPhaseCountOf(RUN_WITH_HUMAN_PARK_ANSWERED);

/** The moving-run bridge with the submit wired to answer, and counted. */
interface AnsweringRunBridge extends MovingRunBridge {
  /** How many submissions reached the wire. What keeps a green case from being empty. */
  readonly submitCount: () => number;
}

/**
 * The moving-run bridge, with `workflow.humanFormSubmit` answering rather than refusing.
 *
 * THE FIXTURE SETTLES NO MUTATION, which is the honest state of a build whose workflow
 * wires are unregistered — so a case driven against it would only ever see the port's
 * typed refusal, and the served arm these cases are about would be unreachable. The one
 * operation is replaced and every other answer stays the fixture's, so the pane under
 * test is the pane.
 *
 * The refusal arm throws rather than returning, because a scripted daemon refusal rejects
 * and the live seam will reject with the same shape once the wire lands.
 */
function bridgeAnsweringSubmits(refusal?: WireErrorEnvelope): AnsweringRunBridge {
  const moving = bridgeWhoseRunMoves();
  let submits = 0;
  const growth: GrowthPort = {
    ...moving.bridge.growth,
    workflowHumanFormSubmit: async (request) => {
      submits += 1;
      if (refusal !== undefined) {
        throw refusal;
      }
      return {
        status: "served",
        value: {
          phaseId: request.phaseId,
          phaseRunId: "019b7a10-0280-7aa1-8100-701a11150005",
          outputCount: 1,
          submittedAt: "2026-01-01T10:02:00.000Z",
        },
      };
    },
  };
  return {
    ...moving,
    bridge: { ...moving.bridge, growth },
    submitCount: () => submits,
  };
}

/** Mount the pane, wait for its first answer, and hand back the pane's own section. */
async function paneShowingTheParkedRun(bridge: ConsoleBridge): Promise<HTMLElement> {
  const section = renderPane(paneContext(PARKED, bridge));
  await waitFor(() => {
    expect(section.querySelectorAll(PARK_SELECTOR)).toHaveLength(PARKED_PHASE_COUNT);
  });
  return section;
}

// The schema form arrives as its own chunk. Resolved once here so every case below
// renders the loaded form rather than the reserved region its mount would otherwise
// suspend on — the loader memoises the load, so this is the state a second form opens in.
beforeAll(loadSchemaFormBody);

describe("workflow run pane — the run moves because a parked phase was answered", () => {
  it("re-reads the run once when the daemon records the form's answer", async () => {
    const probe = bridgeAnsweringSubmits();
    const section = await paneShowingTheParkedRun(probe.bridge);
    expect(probe.runReadCount()).toBe(1);

    // The daemon now holds a run with the human park answered — which is what a served
    // submission MEANS — and nothing on the session says so. The press is the only thing
    // that can tell this pane its answer is stale.
    probe.reportRunAdvanced();
    await act(async () => {
      pressSubmit();
    });
    await settle();

    await waitFor(() => {
      expect(section.querySelectorAll(PARK_SELECTOR)).toHaveLength(ANSWERED_PARK_COUNT);
    });
    // Exactly one further read: the round advances by one per served act, so a pane that
    // asked twice would be re-arming on something other than the settlement.
    expect(probe.runReadCount()).toBe(2);
    expect(probe.submitCount()).toBe(1);
    expect(ANSWERED_PARK_COUNT).toBeLessThan(PARKED_PHASE_COUNT);
    // And no control was pressed, so the round that advanced is the form's own.
    expect(probe.controlCallCount()).toBe(0);
  });

  it("negative control: a refused submission puts no second read", async () => {
    // Without this the case above would hold over a pane that re-read on every press —
    // a read cadence keyed to somebody touching the form rather than to the daemon
    // having moved the run, which asks the daemon again for an answer it just gave.
    const probe = bridgeAnsweringSubmits(STALE_REVISION_REFUSAL);
    const section = await paneShowingTheParkedRun(probe.bridge);

    // Armed exactly as the case above arms it, so the two differ in what the daemon said
    // to the submission and in nothing else: a pane that did re-read would be caught by
    // the DOM as well as by the count.
    probe.reportRunAdvanced();
    await act(async () => {
      pressSubmit();
    });
    await settle();

    // The press reached the wire and the refusal reached the screen, so this is a case
    // about what a refusal buys rather than about a button nobody managed to press.
    expect(probe.submitCount()).toBe(1);
    expect(section.textContent).toContain(STALE_REVISION_REFUSAL.message);
    expect(probe.runReadCount()).toBe(1);
    expect(section.querySelectorAll(PARK_SELECTOR)).toHaveLength(PARKED_PHASE_COUNT);
  });
});
