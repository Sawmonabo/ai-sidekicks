// What a caller asking this scenario a workflow read is answered with.
//
// Every case drives `settleScriptedReply` — the one seam a served growth operation
// answers a workflow read through — rather than reading `scenario.replies` directly.
// Reading the array would assert that a literal is present; driving the seam asserts
// that a caller asking for that call GETS it, which is the property the panes depend
// on and the only one that can break.

import { describe, expect, it } from "vitest";

import { WORKFLOWS_SCENARIO_DEFINITIONS } from "./workflow-fixture-definitions.js";
import {
  WORKFLOWS_COMPLETED_PHASE_ID,
  WORKFLOWS_SCENARIO_PHASE_OUTPUTS,
} from "./workflow-fixture-phase-outputs.js";
import { WORKFLOWS_PARKED_RUN, WORKFLOWS_SCENARIO_RUNS } from "./workflow-fixture-runs.js";
import { WORKFLOWS_SCENARIO } from "./workflows.js";
import { ScenarioEngine } from "../scenario-engine.js";
import { settleScriptedReply } from "../scripted-reply.js";
import type { WorkflowRunListEntry } from "../workflow-projection.js";

/**
 * The definition facts the enumeration pairs with each run, one constant per
 * definition rather than one per run — because two of the four runs came from the
 * same definition and writing that pairing twice is how a fixture assertion comes to
 * disagree with the fixture.
 */
const RELEASE_CHECKS_DEFINITION_FACTS = {
  definitionName: "Release checks",
  definitionLatestWorkflowVersionId: "019b7a10-0280-7d22-8100-be5100150004",
} as const;

const SHIP_PIPELINE_DEFINITION_FACTS = {
  definitionName: "Ship pipeline",
  definitionLatestWorkflowVersionId: "019b7a10-0280-7d22-8100-be5100150003",
} as const;

const INCIDENT_TRIAGE_DEFINITION_FACTS = {
  definitionName: "Incident triage",
  definitionLatestWorkflowVersionId: "019b7a10-0280-7d22-8100-be5100150002",
} as const;

/** The enumeration's entries, settled and narrowed, for the cases that read them. */
async function enumerationEntries(
  engine: ScenarioEngine,
): Promise<readonly WorkflowRunListEntry[]> {
  const runList = await settleScriptedReply(engine, "workflow.runList");
  if (runList.status !== "resolved") {
    throw new Error(`the enumeration settled ${runList.status}`);
  }
  return (runList.value as { readonly runs: readonly WorkflowRunListEntry[] }).runs;
}

describe("the workflows scenario — what a caller is answered with", () => {
  it("answers the four workflow reads through the scripted-reply seam", async () => {
    const engine = new ScenarioEngine({ scenario: WORKFLOWS_SCENARIO });

    const definitionList = await settleScriptedReply(engine, "workflow.definitionList");
    const runList = await settleScriptedReply(engine, "workflow.runList");
    const runRead = await settleScriptedReply(engine, "workflow.runRead");
    const phaseOutputRead = await settleScriptedReply(engine, "workflow.phaseOutputRead");

    expect(definitionList).toStrictEqual({
      status: "resolved",
      value: { definitions: WORKFLOWS_SCENARIO_DEFINITIONS },
    });
    // Every run in the table, unsorted: the attention ordering is the console's fold
    // and a reply that pre-sorted them would hide a fold that had stopped working.
    // Each row widened by exactly the two definition facts the ENUMERATION carries
    // and the run read does not — the run's own members are untouched, which is what
    // `enumerationEntries` below asserts member by member.
    expect(runList).toStrictEqual({
      status: "resolved",
      value: {
        runs: [
          { ...WORKFLOWS_SCENARIO_RUNS[0], ...RELEASE_CHECKS_DEFINITION_FACTS },
          { ...WORKFLOWS_PARKED_RUN, ...SHIP_PIPELINE_DEFINITION_FACTS },
          { ...WORKFLOWS_SCENARIO_RUNS[2], ...INCIDENT_TRIAGE_DEFINITION_FACTS },
          { ...WORKFLOWS_SCENARIO_RUNS[3], ...SHIP_PIPELINE_DEFINITION_FACTS },
        ],
      },
    });
    expect(runRead).toStrictEqual({ status: "resolved", value: WORKFLOWS_PARKED_RUN });
    expect(phaseOutputRead).toStrictEqual({
      status: "resolved",
      value: {
        phaseId: WORKFLOWS_COMPLETED_PHASE_ID,
        state: "completed",
        outputs: WORKFLOWS_SCENARIO_PHASE_OUTPUTS,
      },
    });
    engine.dispose();
  });

  it("scripts no mutating workflow call", async () => {
    // The negative control for the case above, and a rule in its own right: a scripted
    // answer is a fixed value rather than a state machine, so a cancel that "succeeded"
    // would sit beside a run read still answering `suspended`.
    const engine = new ScenarioEngine({ scenario: WORKFLOWS_SCENARIO });

    for (const call of [
      "workflow.runCancel",
      "workflow.runResume",
      "workflow.gateResolve",
      "workflow.humanFormSubmit",
      "workflow.runStart",
    ]) {
      expect(await settleScriptedReply(engine, call)).toStrictEqual({ status: "unscripted" });
    }
    engine.dispose();
  });

  it("answers the run read with a run the list also carries", async () => {
    // The pane's run and the list's run are one object, not two literals that agree
    // today. Identity rather than deep equality, because deep equality would still pass
    // for two copies that a later edit could take apart.
    const engine = new ScenarioEngine({ scenario: WORKFLOWS_SCENARIO });

    const runRead = await settleScriptedReply(engine, "workflow.runRead");

    expect(runRead.status).toBe("resolved");
    expect(WORKFLOWS_SCENARIO_RUNS).toContain(WORKFLOWS_PARKED_RUN);
    engine.dispose();
  });

  it("answers the enumeration with the pane's own run, widened and not rebuilt", async () => {
    // The same claim one seam further out, restated for a reply that must ADD two
    // members: an entry cannot be the run object itself any more, so what is asserted
    // is that it is that object spread — every run member equal, and the phase
    // collection the SAME array, which a rebuilt table could not produce.
    const engine = new ScenarioEngine({ scenario: WORKFLOWS_SCENARIO });

    const enumerated = await enumerationEntries(engine);
    const parked = enumerated.find(
      (entry) => entry.workflowRunId === WORKFLOWS_PARKED_RUN.workflowRunId,
    );

    expect(enumerated).toHaveLength(4);
    expect(parked).toStrictEqual({ ...WORKFLOWS_PARKED_RUN, ...SHIP_PIPELINE_DEFINITION_FACTS });
    expect(parked?.phaseStates).toBe(WORKFLOWS_PARKED_RUN.phaseStates);
    engine.dispose();
  });

  it("names a definition for every run, including the one pinned behind its latest", async () => {
    // The frozen pin is the case no derivation can recover: its version is nobody's
    // latest, so a fixture that paired runs by matching the definition table would
    // leave exactly the run the label exists for without a definition at all.
    const engine = new ScenarioEngine({ scenario: WORKFLOWS_SCENARIO });

    const enumerated = await enumerationEntries(engine);
    const frozen = enumerated.filter(
      (entry) => entry.definitionLatestWorkflowVersionId !== entry.workflowVersionId,
    );

    expect(enumerated.every((entry) => entry.definitionName.length > 0)).toBe(true);
    expect(frozen).toHaveLength(1);
    expect(frozen[0]?.definitionName).toBe("Ship pipeline");
    engine.dispose();
  });
});
