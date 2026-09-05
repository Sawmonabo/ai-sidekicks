// What a caller asking this scenario a workflow read is answered with.
//
// Every case drives `settleScriptedReply` — the one seam a served growth operation
// answers a workflow read through — rather than reading `scenario.replies` directly.
// Reading the array would assert that a literal is present; driving the seam asserts
// that a caller asking for that call GETS it, which is the property the panes depend
// on and the only one that can break.

import { describe, expect, it } from "vitest";

import { GROWTH_OPERATIONS } from "../growth-operations/index.js";

import { WORKFLOWS_SCENARIO_DEFINITIONS } from "./workflow-fixture-definitions.js";
import {
  WORKFLOWS_COMPLETED_PHASE_ID,
  WORKFLOWS_SCENARIO_PHASE_OUTPUTS,
} from "./workflow-fixture-phase-outputs.js";
import { WORKFLOWS_PARKED_RUN, WORKFLOWS_SCENARIO_RUNS } from "./workflow-fixture-runs.js";
import { WORKFLOWS_RUN_ENUMERATION_CALL, WORKFLOWS_SCENARIO } from "./workflows.js";
import { ScenarioEngine } from "../scenario-engine.js";
import { settleScriptedReply } from "../scripted-reply.js";
import type { WorkflowRunListEntry, WorkflowRunSnapshot } from "../workflow-projection.js";

/** A run id this scenario's table does not carry, standing in for "some other run". */
const UNLISTED_RUN_ID = "019b7a10-0280-7b33-8100-000000000000";

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
  const runList = await settleScriptedReply(engine, WORKFLOWS_RUN_ENUMERATION_CALL);
  if (runList.status !== "resolved") {
    throw new Error(`the enumeration settled ${runList.status}`);
  }
  return (runList.value as { readonly runs: readonly WorkflowRunListEntry[] }).runs;
}

describe("the workflows scenario — what a caller is answered with", () => {
  it("answers the four workflow reads through the scripted-reply seam", async () => {
    const engine = new ScenarioEngine({ scenario: WORKFLOWS_SCENARIO });

    const definitionList = await settleScriptedReply(engine, "workflow.definitionList");
    const runList = await settleScriptedReply(engine, WORKFLOWS_RUN_ENUMERATION_CALL);
    // Addressed, because both snapshot reads answer per request: a run read is one of
    // the registered workflow methods and addresses one run by an id the caller holds,
    // and this fixture now answers it that way rather than with one fixed run.
    const runRead = await settleScriptedReply(engine, "workflow.runRead", {
      workflowRunId: WORKFLOWS_PARKED_RUN.workflowRunId,
    });
    const phaseOutputRead = await settleScriptedReply(engine, "workflow.phaseOutputRead", {
      workflowRunId: WORKFLOWS_PARKED_RUN.workflowRunId,
      phaseId: WORKFLOWS_COMPLETED_PHASE_ID,
    });

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

  it("keys the run enumeration on its growth operation and not on an invented method", () => {
    // The console has one rule about method strings — a name is transcribed from a
    // registered contract or it is not written — and this scenario is where the
    // workflow plane's names get written. `growth-operations/workflows.ts` registers
    // `workflowRunList` with `expectedWireMethod` undefined, under the note that an
    // invented string there would be a wire fact traceable to nothing; a
    // `workflow.runList` literal HERE is that same invention one file further from
    // the ledger that refused it, and nothing between the two would have caught it.
    //
    // Two claims, and the second is the one that bites. Every `workflow.`-prefixed
    // call this scenario scripts is some operation's registered method — so the three
    // transcriptions stay transcriptions — and the enumeration, which has no method to
    // transcribe, wears a key no daemon method can: the operation id under a `growth:`
    // prefix. On the old code the enumeration failed the first claim and the second.
    const registeredWorkflowMethods = new Set<string>(
      Object.values(GROWTH_OPERATIONS).flatMap((operation) =>
        operation.expectedWireMethod === undefined ? [] : [operation.expectedWireMethod],
      ),
    );
    const workflowCalls = WORKFLOWS_SCENARIO.replies
      .map((reply) => reply.call)
      .filter((call) => call.startsWith("workflow."));

    // The zero-match guard: a scenario that scripted no workflow reply at all would
    // satisfy the filter below vacuously.
    expect(workflowCalls).toHaveLength(3);
    expect(workflowCalls.filter((call) => !registeredWorkflowMethods.has(call))).toStrictEqual([]);

    expect(GROWTH_OPERATIONS.workflowRunList.expectedWireMethod).toBeUndefined();
    expect(WORKFLOWS_RUN_ENUMERATION_CALL).toBe(`growth:${GROWTH_OPERATIONS.workflowRunList.id}`);
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

    const runRead = await settleScriptedReply(engine, "workflow.runRead", {
      workflowRunId: WORKFLOWS_PARKED_RUN.workflowRunId,
    });

    expect(runRead).toStrictEqual({ status: "resolved", value: WORKFLOWS_PARKED_RUN });
    expect(runRead.status === "resolved" ? runRead.value : undefined).toBe(WORKFLOWS_PARKED_RUN);
    expect(WORKFLOWS_SCENARIO_RUNS).toContain(WORKFLOWS_PARKED_RUN);
    engine.dispose();
  });

  it("reads every run the enumeration lists, and agrees with the entry it listed", async () => {
    // The defect this closes: the destination renders all four entries as openable and
    // the run read answered only the parked one, so three of the four refused
    // `workflow.not_found` against a list this same fixture had just served.
    //
    // A property over the enumeration rather than four hand-written cases: a fifth run
    // added next door is covered the moment it is listed, and no case can pass by
    // naming a run the list does not carry.
    const engine = new ScenarioEngine({ scenario: WORKFLOWS_SCENARIO });
    const enumerated = await enumerationEntries(engine);

    expect(enumerated).toHaveLength(4);
    for (const entry of enumerated) {
      const runRead = await settleScriptedReply(engine, "workflow.runRead", {
        workflowRunId: entry.workflowRunId,
      });
      const snapshot =
        runRead.status === "resolved" ? (runRead.value as WorkflowRunSnapshot) : undefined;

      expect(runRead.status).toBe("resolved");
      // Every member the two shapes share, and the phase collection by IDENTITY: the
      // entry is the snapshot spread, so the same array reaches both. A second table
      // of runs behind the read would agree member by member and fail exactly here.
      expect(snapshot?.workflowRunId).toBe(entry.workflowRunId);
      expect(snapshot?.state).toBe(entry.state);
      expect(snapshot?.startedAt).toBe(entry.startedAt);
      expect(snapshot?.workflowVersionId).toBe(entry.workflowVersionId);
      expect(snapshot?.phaseStates).toBe(entry.phaseStates);
    }
    engine.dispose();
  });

  it("negative control: a run the enumeration does not list is refused", async () => {
    // Without this the property above would pass over a reply that answered any run id
    // at all with whatever it had — which is the shape being replaced, and the reason
    // the list and the read could disagree in the first place.
    const engine = new ScenarioEngine({ scenario: WORKFLOWS_SCENARIO });
    const enumerated = await enumerationEntries(engine);

    expect(enumerated.some((entry) => entry.workflowRunId === UNLISTED_RUN_ID)).toBe(false);
    await expect(
      settleScriptedReply(engine, "workflow.runRead", { workflowRunId: UNLISTED_RUN_ID }),
    ).rejects.toStrictEqual({
      code: "workflow.not_found",
      message: `No workflow run \`${UNLISTED_RUN_ID}\` exists on this node.`,
    });
    engine.dispose();
  });

  it("pins the phase outputs to the one run whose work they are", async () => {
    // The run read used to be this reply's pin — the port held both reads to the one
    // run the run read's fixed value named — and a run read that answers four runs
    // cannot stand in for it. Served under another run, a completed phase's outputs
    // would read as that run's work, and three of the four runs carry a completed
    // phase with this very id.
    const engine = new ScenarioEngine({ scenario: WORKFLOWS_SCENARIO });
    const otherRun = WORKFLOWS_SCENARIO_RUNS.find(
      (run) => run.workflowRunId !== WORKFLOWS_PARKED_RUN.workflowRunId,
    );

    expect(
      otherRun?.phaseStates.some((phase) => phase.phaseId === WORKFLOWS_COMPLETED_PHASE_ID),
    ).toBe(true);
    await expect(
      settleScriptedReply(engine, "workflow.phaseOutputRead", {
        workflowRunId: otherRun?.workflowRunId,
        phaseId: WORKFLOWS_COMPLETED_PHASE_ID,
      }),
    ).rejects.toMatchObject({ code: "workflow.not_found" });
    engine.dispose();
  });

  it("settles a request-less probe of either snapshot read as unscripted", async () => {
    // The growth port's own outcome for an operation asked about nothing, which the
    // scripted-reply seam states as its rule for a computed reply: an authoring gap
    // rather than a refusal, so the port answers with whatever that operation's honest
    // unscripted answer is instead of a daemon code nobody sent.
    const engine = new ScenarioEngine({ scenario: WORKFLOWS_SCENARIO });

    expect(await settleScriptedReply(engine, "workflow.runRead")).toStrictEqual({
      status: "unscripted",
    });
    expect(await settleScriptedReply(engine, "workflow.phaseOutputRead")).toStrictEqual({
      status: "unscripted",
    });
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
