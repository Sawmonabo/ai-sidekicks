// What the fixture answers a workflow read with, and what it refuses to invent.
//
// A file of its own rather than a fourth block under `fixture-growth-port.test.ts`,
// because the two are maintained against different things: that suite is about the
// port's SERVED SET — every operation called, each answer checked against the set the
// composition root reads synchronously — while this one is about four operations'
// CONTENT, and the scenario fixtures it reads are re-scripted whenever the workflows
// family grows a surface. Held together they were one module past the package's split
// threshold whose two halves moved on unrelated schedules.
//
// Four operations, one seam, and two different honest absences — which is why THESE
// are held together. The claim is not that a call returns something. It is that what
// a scenario STATES reaches the caller unchanged, and that a scenario stating nothing
// gets the answer its value shape admits: an empty enumeration where an empty
// enumeration is a real reply, a refusal where the only alternative is an invented
// run.
//
// The split runs along the value shape and not along the slate row. Both enumerations
// answer empty — an empty list of definitions and an empty list of runs are each a
// real answer — while both snapshot reads refuse, and that holds even though the run
// enumeration is the one operation of the four whose row registers no method at all.
//
// The flagship is the negative control throughout. It scripts none of the four, so
// each case that reads the workflows script has a counterpart driven over it, and a
// port answering from a constant instead of from the script would pass one of every
// pair and fail the other.

import { describe, expect, it } from "vitest";

import { isWireErrorEnvelope, type WireErrorEnvelope } from "../../../../shared/wire-errors.js";
import { createFixtureBridge } from "./fixture-bridge.js";
import { callOperation, fixturePort } from "./fixture-growth-port.test-support.js";
import { FIXTURE_SERVED_GROWTH_OPERATION_IDS } from "./fixture-growth-port.js";
import type { GrowthOperationId } from "./growth-entry.js";
import type { GrowthPort } from "./growth-port.js";
import { GROWTH_OPERATIONS } from "./growth-operations.js";
import { FLAGSHIP_SCENARIO } from "./scenarios/flagship.js";
import { WORKFLOWS_SCENARIO_DEFINITIONS } from "./scenarios/workflow-fixture-definitions.js";
import {
  WORKFLOWS_COMPLETED_PHASE_ID,
  WORKFLOWS_SCENARIO_PHASE_OUTPUTS,
} from "./scenarios/workflow-fixture-phase-outputs.js";
import {
  WORKFLOWS_PARKED_RUN,
  WORKFLOWS_SCENARIO_RUNS,
} from "./scenarios/workflow-fixture-runs.js";
import { WORKFLOWS_SCENARIO } from "./scenarios/workflows.js";

/** The fixture port playing the scenario that scripts all three workflow reads. */
function workflowsPort(): GrowthPort {
  return createFixtureBridge({ scenario: WORKFLOWS_SCENARIO }).growth;
}

/**
 * The daemon envelope a read REJECTED with.
 *
 * A rejection rather than an outcome arm, because that is what a daemon refusal is
 * on this seam: the growth outcome union deliberately has no arm for one, so a
 * scripted refusal and an out-of-scope identifier both travel as the wire's own
 * `{code, message}` thrown verbatim. A read that answers where a refusal was
 * expected fails HERE, naming that, rather than leaving an assertion to read a
 * member off a value that never refused.
 */
async function refusalFrom(read: Promise<unknown>): Promise<WireErrorEnvelope> {
  try {
    await read;
  } catch (rejection) {
    if (isWireErrorEnvelope(rejection)) {
      return rejection;
    }
    throw rejection;
  }
  throw new Error("the read answered where a daemon refusal was expected");
}

describe("the fixture's workflow reads — answered from the script, never invented", () => {
  it("enumerates the definitions the scenario states, and synthesizes no cursor", async () => {
    const outcome = await workflowsPort().workflowDefinitionList({
      sessionId: WORKFLOWS_SCENARIO.sessionId,
    });

    expect(outcome.status).toBe("served");
    if (outcome.status === "served") {
      expect(outcome.value.definitions).toStrictEqual(WORKFLOWS_SCENARIO_DEFINITIONS);
      // The scenario's reply omits it and the fixture must not fill it in: a cursor
      // here would promise a second page that every later fetch — the engine matching
      // a reply by call name — would answer with this same one forever.
      expect(outcome.value.nextCursor).toBeUndefined();
    }
  });

  it("answers the run read with the very run the scenario states", async () => {
    const outcome = await workflowsPort().workflowRunRead({
      workflowRunId: WORKFLOWS_PARKED_RUN.workflowRunId,
    });

    expect(outcome.status).toBe("served");
    if (outcome.status === "served") {
      // Identity rather than deep equality: the pane's run and the list's run are one
      // object, and two copies that agree today are what a later edit takes apart
      // with nothing to notice.
      expect(outcome.value).toBe(WORKFLOWS_PARKED_RUN);
    }
  });

  it("answers the phase-output read for the phase the scenario finished", async () => {
    const outcome = await workflowsPort().workflowPhaseOutputRead({
      workflowRunId: WORKFLOWS_PARKED_RUN.workflowRunId,
      phaseId: WORKFLOWS_COMPLETED_PHASE_ID,
    });

    expect(outcome.status).toBe("served");
    if (outcome.status === "served") {
      expect(outcome.value.phaseId).toBe(WORKFLOWS_COMPLETED_PHASE_ID);
      expect(outcome.value.state).toBe("completed");
      expect(outcome.value.outputs).toStrictEqual(WORKFLOWS_SCENARIO_PHASE_OUTPUTS);
    }
  });

  it("enumerates the runs the scenario states, in the table's own order", async () => {
    const outcome = await workflowsPort().workflowRunList({
      sessionId: WORKFLOWS_SCENARIO.sessionId,
    });

    expect(outcome.status).toBe("served");
    if (outcome.status === "served") {
      // Unsorted: the attention ordering is the console's fold, so a port that sorted
      // on the way out would hide a fold that had stopped working behind data that
      // arrived already correct. Asserted by run id rather than by identity, because
      // the enumeration answers with each run WIDENED by the definition facts a run
      // read does not carry — the scenario's own suite holds that pairing.
      expect(outcome.value.runs.map((run) => run.workflowRunId)).toStrictEqual(
        WORKFLOWS_SCENARIO_RUNS.map((run) => run.workflowRunId),
      );
      const parked = outcome.value.runs.find(
        (run) => run.workflowRunId === WORKFLOWS_PARKED_RUN.workflowRunId,
      );
      expect(parked?.phaseStates).toBe(WORKFLOWS_PARKED_RUN.phaseStates);
    }
  });

  it("answers a scenario that scripts no definitions with an empty enumeration", async () => {
    // Served-and-empty, not refused: the operation IS answered here and what it found
    // is nothing, which is the EMPTY kind of nothing a definition browser draws.
    const outcome = await fixturePort().workflowDefinitionList({
      sessionId: FLAGSHIP_SCENARIO.sessionId,
    });

    expect(outcome.status).toBe("served");
    if (outcome.status === "served") {
      expect(outcome.value).toStrictEqual({ definitions: [] });
    }
  });

  it("answers a scenario that scripts no runs with an empty enumeration", async () => {
    // The enumeration's counterpart to the case above, and the reason it sits with the
    // definitions rather than with the two refusals below: a session that holds no run
    // is a fact a daemon can state, so the honest answer is served-and-empty and the
    // list draws the EMPTY kind of nothing. The refusal arm belongs to reads that
    // could only answer by inventing a run.
    const outcome = await fixturePort().workflowRunList({
      sessionId: FLAGSHIP_SCENARIO.sessionId,
    });

    expect(outcome.status).toBe("served");
    if (outcome.status === "served") {
      expect(outcome.value).toStrictEqual({ runs: [] });
    }
  });

  it("refuses the two snapshot reads for a scenario that scripts neither", async () => {
    // The negative control for the three script-driven cases above, and the rule this
    // routing exists under in its own right: an unscripted run read must never become
    // an absent value. There is no empty `WorkflowRunSnapshot` and no phase this
    // fixture could name as finished, so an answer here would be an invented run and
    // an invented phase — and a run pane offers operator controls on what it holds.
    const port = fixturePort();

    for (const outcome of [
      await port.workflowRunRead({ workflowRunId: WORKFLOWS_PARKED_RUN.workflowRunId }),
      await port.workflowPhaseOutputRead({
        workflowRunId: WORKFLOWS_PARKED_RUN.workflowRunId,
        phaseId: WORKFLOWS_COMPLETED_PHASE_ID,
      }),
    ]) {
      expect(outcome.status).toBe("unavailable");
      if (outcome.status === "unavailable") {
        expect(outcome.code).toBe("wire-unregistered");
        expect(outcome.slateRow).toBe("workflow-run-control");
      }
      expect(outcome).not.toHaveProperty("value");
    }
  });

  it("enumerates nothing for a session this scenario is not playing", async () => {
    // The defect, on the enumerations: a scripted reply is matched by call name, so
    // both answered ANY session with this scenario's rows — one session's definitions
    // and runs shown under another session's name, and a list of runs a person cannot
    // open, cancel or account for. Empty rather than refused, on the rule
    // `attentionProjectionRead` states one function up: the operation IS served and
    // what it found for that session here is nothing.
    const port = workflowsPort();
    const definitions = await port.workflowDefinitionList({
      sessionId: FLAGSHIP_SCENARIO.sessionId,
    });
    const runs = await port.workflowRunList({ sessionId: FLAGSHIP_SCENARIO.sessionId });

    expect(definitions.status === "served" ? definitions.value : undefined).toStrictEqual({
      definitions: [],
    });
    expect(runs.status === "served" ? runs.value : undefined).toStrictEqual({ runs: [] });
  });

  it("reads every run the scenario lists, each with its own snapshot", async () => {
    // The defect this closes: the scenario answered `workflow.runRead` with one fixed
    // run, so the destination listed four runs as openable and three of them refused
    // against a list the same fixture had just served. Driven through the PORT rather
    // than through the scenario, because the scope check in front of the reply is the
    // half that used to refuse.
    const port = workflowsPort();

    for (const listed of WORKFLOWS_SCENARIO_RUNS) {
      const outcome = await port.workflowRunRead({ workflowRunId: listed.workflowRunId });
      expect(outcome.status).toBe("served");
      // The listed object itself, not a copy: the enumeration and the read are one
      // table, so a run opened from the list reads exactly the row that was listed.
      expect(outcome.status === "served" ? outcome.value : undefined).toBe(listed);
    }
  });

  it("refuses the run read for a run it projects no snapshot for", async () => {
    // The other half, and the one the scoping was added for: a run id this scenario
    // holds nothing for must not be answered with somebody else's snapshot. The
    // refusal is the daemon's own registered code, thrown verbatim, whichever of the
    // two mechanisms — the port's scope check or the computed reply — produces it.
    const unlistedRunId = "019b7a10-0280-7b33-8100-000000000000";
    expect(WORKFLOWS_SCENARIO_RUNS.some((run) => run.workflowRunId === unlistedRunId)).toBe(false);

    const refusal = await refusalFrom(
      workflowsPort().workflowRunRead({ workflowRunId: unlistedRunId }),
    );

    expect(refusal.code).toBe("workflow.not_found");
    expect(refusal.message).toContain(unlistedRunId);
  });

  it("refuses the phase-output read on either identifier it is addressed by", async () => {
    // Both, because the read is addressed by both: a completed phase's outputs served
    // under another run would read as that run's work, and another phase's id would
    // attribute one phase's outputs to a phase that produced none.
    const port = workflowsPort();

    for (const read of [
      port.workflowPhaseOutputRead({
        // Another run this scenario DOES list, and one that carries a completed phase
        // with this very id — so the outputs are pinned to their own run rather than
        // to whichever run happens to be readable.
        workflowRunId: WORKFLOWS_SCENARIO_RUNS[0]?.workflowRunId ?? "",
        phaseId: WORKFLOWS_COMPLETED_PHASE_ID,
      }),
      port.workflowPhaseOutputRead({
        workflowRunId: WORKFLOWS_PARKED_RUN.workflowRunId,
        phaseId: "019b7a10-0280-7e44-8100-000000000000",
      }),
    ]) {
      expect((await refusalFrom(read)).code).toBe("workflow.not_found");
    }
  });

  it("negative control: the identifiers the scenario states are still served", async () => {
    // Without this the four refusals above would pass over a port that refused every
    // workflow read, and the fixture would answer nothing at all. The three cases at
    // the head of this suite assert what comes back; this asserts that the scoping
    // added in front of them refuses none of it.
    const port = workflowsPort();

    for (const outcome of [
      await port.workflowDefinitionList({ sessionId: WORKFLOWS_SCENARIO.sessionId }),
      await port.workflowRunList({ sessionId: WORKFLOWS_SCENARIO.sessionId }),
      await port.workflowRunRead({ workflowRunId: WORKFLOWS_PARKED_RUN.workflowRunId }),
      await port.workflowPhaseOutputRead({
        workflowRunId: WORKFLOWS_PARKED_RUN.workflowRunId,
        phaseId: WORKFLOWS_COMPLETED_PHASE_ID,
      }),
    ]) {
      expect(outcome.status).toBe("served");
    }
  });

  it("routes no workflow mutation, a scripted reply being a value and not a state machine", async () => {
    // A cancel that answered would sit beside a run read still reporting `suspended`.
    // The set is derived from the ledger minus the served set rather than listed here,
    // so a mutation routed later fails this case instead of shipping quietly.
    const port = workflowsPort();
    const served = new Set<string>(FIXTURE_SERVED_GROWTH_OPERATION_IDS);
    const unrouted = (Object.keys(GROWTH_OPERATIONS) as GrowthOperationId[]).filter(
      (operationId) =>
        GROWTH_OPERATIONS[operationId].slateRow === "workflow-run-control" &&
        !served.has(operationId),
    );

    // Six: five mutations and the gate-chain verification. Counted so a row that
    // quietly lost its operations cannot make the loop below vacuously pass.
    expect(unrouted).toHaveLength(6);
    for (const operationId of unrouted) {
      const outcome = await callOperation(port, operationId, WORKFLOWS_SCENARIO.sessionId);

      expect(outcome.status, operationId).toBe("unavailable");
      if (outcome.status === "unavailable") {
        expect(outcome.code, operationId).toBe("wire-unregistered");
      }
    }
  });
});
