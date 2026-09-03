// What the fixture serves, and that its claim about it is true.
//
// Two claims travel separately and have to agree: the port ANSWERS two operations,
// and the bridge PUBLISHES a set naming them. The composition root reads the set
// synchronously to decide whether to build a registry that can read at all, so a
// set that over-claims would have the console bind a stream to a store nothing can
// initialise, and a set that under-claims would leave the whole store layer dormant
// against a fixture that was ready to feed it. Neither failure is visible in a
// surface: both render as a console that quietly shows nothing.
//
// So every operation on the port is called, and each answer is checked against the
// set rather than against a list retyped here — and the session reads a store is
// established from are driven beside it, because the served set says an operation
// answers and says nothing about what it answered.
//
// The three subjects that used to sit under this header have their own files, one
// per concern: `fixture-growth-port.attention.test.ts`,
// `fixture-growth-port.gitflow.test.ts`, and
// `fixture-growth-port.refusals.test.ts`.

import { describe, expect, it } from "vitest";

import { isWireErrorEnvelope, type WireErrorEnvelope } from "../../../../shared/wire-errors.js";
import { createFixtureBridge } from "./fixture-bridge.js";
import { callOperation, fixturePort } from "./fixture-growth-port.test-support.js";
import { FIXTURE_SERVED_GROWTH_OPERATION_IDS } from "./fixture-growth-port.js";
import type { GrowthOperationId } from "./growth-entry.js";
import type { GrowthPort } from "./growth-port.js";
import { GROWTH_OPERATIONS } from "./growth-operations.js";
import { createLiveBridge } from "./live-bridge.js";
import type { ConsoleScenario } from "./scenario.js";
import { FIRST_RUN_SCENARIO } from "./scenarios/first-run.js";
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
import { createTier1Bridge } from "@ai-sidekicks/contracts";

/**
 * A scenario whose `session.read` reply declares `state`.
 *
 * The first-run scenario with its one reply rewritten, so the directory reads
 * through the shape a real scenario has. Local to this suite: the co-located
 * `fixture-session-directory.test.ts` drives the derivation directly and this one
 * drives it through the port, which is the seam each is about.
 */
function scenarioDeclaring(state: string): ConsoleScenario {
  return {
    ...FIRST_RUN_SCENARIO,
    id: `first-run-declaring-${state}`,
    replies: FIRST_RUN_SCENARIO.replies.map((reply) =>
      reply.call === "session.read"
        ? {
            call: "session.read",
            result: {
              session: {
                id: FIRST_RUN_SCENARIO.sessionId,
                state,
                config: {},
                metadata: {},
                createdAt: FIRST_RUN_SCENARIO.startedAtIso,
                updatedAt: FIRST_RUN_SCENARIO.startedAtIso,
              },
              timelineCursors: { latest: "first-run-cursor-1" },
            },
          }
        : reply,
    ),
  };
}

describe("the fixture growth port — what it serves, and what it still refuses", () => {
  it("answers every operation its bridge claims to serve, and refuses every other", async () => {
    // Driven over the WORKFLOWS scenario rather than the flagship, on the second half
    // of the rule the helper above states: a served operation may legitimately answer
    // from what the scenario SAYS and refuse where it says nothing —
    // `callerParticipantRead` does that for a viewer, and the two workflow snapshot
    // reads do it for a run that has no empty form. The workflows scenario is the one
    // that states all of it, so a refusal here is a broken served claim rather than a
    // script that has not spoken. The other side of that pair — the flagship, which
    // scripts no workflow read — is driven by the workflow suite at the foot of this
    // file, so neither arm ships untested.
    const scenario = WORKFLOWS_SCENARIO;
    const bridge = createFixtureBridge({ scenario });
    const served = new Set<string>(FIXTURE_SERVED_GROWTH_OPERATION_IDS);

    for (const operationId of Object.keys(GROWTH_OPERATIONS) as GrowthOperationId[]) {
      const outcome = await callOperation(bridge.growth, operationId, scenario.sessionId);
      expect(outcome.status, `${operationId} answered the wrong way`).toBe(
        served.has(operationId) ? "served" : "unavailable",
      );
    }
  });

  it("publishes exactly the set it serves, so the synchronous decision is the true one", () => {
    const bridge = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });

    expect([...bridge.growthServedOperations].sort()).toStrictEqual(
      [...FIXTURE_SERVED_GROWTH_OPERATION_IDS].sort(),
    );
  });

  it("negative control: the live bridge serves none of them and names each one's own row", async () => {
    // Without this the sweep above would hold over a port that served everything.
    // The live arm is the one a release build takes, and it must still render the
    // `not-checked` absence for every wire the fixture answers.
    //
    // The expected row is read from the ledger rather than written out here. A
    // literal would have been right for exactly as long as the served set drew on
    // one slate row, and the assertion it makes — that a refusal attributes to the
    // row that owes ITS wire — is the ledger's claim, not this file's.
    const bridge = createLiveBridge(createTier1Bridge());

    expect([...bridge.growthServedOperations]).toStrictEqual([]);
    for (const operationId of FIXTURE_SERVED_GROWTH_OPERATION_IDS) {
      const outcome = await callOperation(bridge.growth, operationId);
      expect(outcome.status).toBe("unavailable");
      if (outcome.status === "unavailable") {
        expect(outcome.code).toBe("wire-unregistered");
        expect(outcome.slateRow).toBe(GROWTH_OPERATIONS[operationId].slateRow);
      }
    }
  });

  it("reads the base state a store can actually be initialised from", async () => {
    const port = fixturePort();

    const outcome = await port.sessionRead({ sessionId: FLAGSHIP_SCENARIO.sessionId });

    expect(outcome.status).toBe("served");
    if (outcome.status === "served") {
      // Cursor zero, so the store admits the scenario's first beat rather than
      // discarding a stream that starts below its base state.
      expect(outcome.value.cursor).toBe(0);
      expect(outcome.value.participantJoinLog).toStrictEqual(
        FLAGSHIP_SCENARIO.participantIdsInJoinOrder,
      );
    }
  });

  it("lends no session's join order to another, hue allocation keying on it", async () => {
    const port = fixturePort();

    const outcome = await port.sessionRead({ sessionId: "session-somebody-else" });

    expect(outcome.status).toBe("served");
    if (outcome.status === "served") {
      expect(outcome.value.participantJoinLog).toStrictEqual([]);
    }
  });

  it("lists the scenario's session, and names it by its identifier rather than inventing one", async () => {
    const port = fixturePort();

    const outcome = await port.sessionList({});

    expect(outcome.status).toBe("served");
    if (outcome.status === "served") {
      // The state is the one the scenario's own `session.read` reply declares,
      // read rather than assumed: the port used to hardcode `active` on the
      // premise that "a scenario plays one live session", which is exactly the
      // premise the first-run scenario is a counterexample to.
      expect(outcome.value).toStrictEqual([
        { sessionId: FLAGSHIP_SCENARIO.sessionId, state: "active" },
      ]);
    }
  });

  it("answers a first run with an empty directory, because it has no session yet", async () => {
    // The defect this replaces: the directory answered with the scenario's session
    // unconditionally, so the FIRST-RUN scenario — a fresh install whose whole
    // purpose is "no sessions, no agents, no history" — listed a session row on the
    // one surface whose committed screenshot baselines exist to pin the EMPTY kind
    // of nothing (`Spec-023 §Console Design (Meridian)` §The five kinds of nothing).
    //
    // Derived from what the scenario DECLARES rather than from which scenario it is:
    // first-run's `session.read` reply says `provisioning`, which is a session still
    // being created and not one the node has.
    const bridge = createFixtureBridge({ scenario: FIRST_RUN_SCENARIO });

    const outcome = await bridge.growth.sessionList({});

    expect(outcome.status).toBe("served");
    if (outcome.status === "served") {
      // Served-and-empty, not refused: the operation IS answered here, and what it
      // found is nothing. A refusal would render `not-checked`, which says the
      // console never asked.
      expect(outcome.value).toStrictEqual([]);
    }
  });

  it("carries the declared state through rather than relabelling it", async () => {
    // The negative control for the rule above. A port that simply answered empty
    // for every scenario, or that kept hardcoding one state, would satisfy the two
    // cases above; driving a scenario that declares a directory state OTHER than
    // `active` is what separates "read from the reply" from either.
    //
    // `archived` rather than the `paused` this case used to drive: `paused` is not
    // a member of the contract's `SessionState` union, so the old expectation
    // asserted a directory row no daemon can send and made an impossible payload
    // look deliberate. `archived` is registered and is equally not `active`, so the
    // control still separates the two implementations it was written to separate.
    const bridge = createFixtureBridge({ scenario: scenarioDeclaring("archived") });

    const outcome = await bridge.growth.sessionList({});

    expect(outcome.status).toBe("served");
    if (outcome.status === "served") {
      expect(outcome.value).toStrictEqual([
        { sessionId: FIRST_RUN_SCENARIO.sessionId, state: "archived" },
      ]);
    }
  });

  it("refuses a scenario whose declared state the contract does not register", async () => {
    // The other half of the same defect: the old filter admitted `paused`, so a
    // scenario could serve a row no wire returns. It is an authoring defect in
    // in-tree source, so the derivation refuses by name and the refusal reaches the
    // caller rather than being flattened into the empty directory a first run
    // legitimately produces — which is what an empty answer here would look like.
    const bridge = createFixtureBridge({ scenario: scenarioDeclaring("paused") });

    await expect(bridge.growth.sessionList({})).rejects.toThrow(/session-state-unregistered/u);
  });
});

// The workflow reads.
//
// Four operations, one seam, and two different honest absences — which is why they
// are held together rather than one per surface. The claim is not that a call returns
// something. It is that what a scenario STATES reaches the caller unchanged, and that
// a scenario stating nothing gets the answer its value shape admits: an empty
// enumeration where an empty enumeration is a real reply, a refusal where the only
// alternative is an invented run.
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

  it("refuses the run read for a run it projects no snapshot for", async () => {
    // The defect this closes: the scripted reply is matched by CALL NAME, so the
    // handler answered any run id at all with the parked run — a run pane opened on
    // the working run would have shown the parked run's phases, parks and controls
    // under the working run's name.
    const working = WORKFLOWS_SCENARIO_RUNS.find(
      (run) => run.workflowRunId !== WORKFLOWS_PARKED_RUN.workflowRunId,
    );
    expect(working).toBeDefined();

    const refusal = await refusalFrom(
      workflowsPort().workflowRunRead({ workflowRunId: working?.workflowRunId ?? "" }),
    );

    expect(refusal.code).toBe("workflow.not_found");
    expect(refusal.message).toContain(working?.workflowRunId ?? "");
  });

  it("refuses the phase-output read on either identifier it is addressed by", async () => {
    // Both, because the read is addressed by both: a completed phase's outputs served
    // under another run would read as that run's work, and another phase's id would
    // attribute one phase's outputs to a phase that produced none.
    const port = workflowsPort();

    for (const read of [
      port.workflowPhaseOutputRead({
        workflowRunId: "019b7a10-0280-7b33-8100-000000000000",
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
